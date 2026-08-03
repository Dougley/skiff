import assert from "node:assert/strict";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv({ LLM_MAX_RETRIES: "0" });

type Queued = LanguageModelV3GenerateResult | Error;

const llm = vi.hoisted(() => ({
  queue: [] as (LanguageModelV3GenerateResult | Error)[],
  /** Model ids handed to getLLMProvider, in call order. */
  modelIds: [] as (string | undefined)[],
  /** Prompt text of every generation the extractor issued. */
  prompts: [] as string[],
}));

vi.mock("../../../src/ai/llm/provider.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/ai/llm/provider.js")>();
  const { MockLanguageModelV3 } = await import("ai/test");
  return {
    ...actual,
    getLLMProvider: (_provider: unknown, modelId?: string) => {
      llm.modelIds.push(modelId);
      return new MockLanguageModelV3({
        doGenerate: async (options) => {
          llm.prompts.push(JSON.stringify(options.prompt));
          const next = llm.queue.shift();
          if (next === undefined) throw new Error("llm mock queue is empty");
          if (next instanceof Error) throw next;
          return next;
        },
      });
    },
  };
});

// the flush path writes through the store; capturing the calls keeps this file
// about extraction and debouncing rather than about SQL.
const stored = vi.hoisted(() => ({
  calls: [] as Record<string, unknown>[],
  fail: false,
}));

vi.mock("../../../src/ai/memory/store.js", () => ({
  storeExtraction: async (params: Record<string, unknown>) => {
    stored.calls.push(params);
    if (stored.fail) throw new Error("store is down");
  },
  upsertUserFacts: async () => 0,
  insertTopicSummary: async () => null,
}));

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function jsonResult(value: unknown): Queued {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  };
}

let extract: typeof import("../../../src/ai/memory/extract.js");
let env: typeof import("../../../src/config/env.js").env;
let logger: typeof import("../../../src/config/logger.js").logger;

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

beforeAll(async () => {
  const [extractModule, envModule, loggerModule] = await Promise.all([
    import("../../../src/ai/memory/extract.js"),
    import("../../../src/config/env.js"),
    import("../../../src/config/logger.js"),
  ]);
  extract = extractModule;
  env = envModule.env;
  logger = loggerModule.logger;
});

beforeEach(() => {
  llm.queue.length = 0;
  llm.modelIds.length = 0;
  llm.prompts.length = 0;
  stored.calls.length = 0;
  stored.fail = false;
});

afterEach(() => {
  vi.useRealTimers();
  env.MEMORY_EXTRACT_MODEL = undefined;
});

/** Drains the promise chain the flush kicks off, under fake timers. */
async function drainMicrotasks(rounds = 30) {
  for (let round = 0; round < rounds; round++) {
    await Promise.resolve();
  }
}

test("a turn set with nothing said in it never reaches the model", async () => {
  assert.deepEqual(await extract.extractMemory([]), { userFacts: [] });
  assert.deepEqual(
    await extract.extractMemory([{ userText: "   ", assistantText: "\n" }]),
    { userFacts: [] }
  );
  assert.equal(llm.modelIds.length, 0);
});

test("extraction is skipped entirely when the model is disabled", async () => {
  env.MEMORY_EXTRACT_MODEL = "disabled";
  assert.deepEqual(
    await extract.extractMemory([{ userText: "hi", assistantText: "hey" }]),
    { userFacts: [] }
  );
  assert.equal(llm.modelIds.length, 0);
});

test("facts and a topic summary come back normalized", async () => {
  llm.queue.push(
    jsonResult({
      userFacts: [
        { fact: "lives in Lisbon", category: "personal", confidence: 150 },
        { fact: "hates meetings", confidence: -5, scope: "global" },
        { fact: "runs the deploy rota" },
      ],
      topicSummary: {
        title: "Deploy rota",
        summary: "Fridays are off-limits.",
        tags: ["ops"],
      },
    })
  );

  const result = await extract.extractMemory([
    { userText: "I live in Lisbon", assistantText: "Noted." },
    { userText: "", assistantText: "Anything else?" },
  ]);

  assert.deepEqual(result.userFacts, [
    { fact: "lives in Lisbon", category: "personal", confidence: 100 },
    { fact: "hates meetings", confidence: 0, scope: "global" },
    { fact: "runs the deploy rota", confidence: undefined },
  ]);
  assert.deepEqual(result.topicSummary, {
    title: "Deploy rota",
    summary: "Fridays are off-limits.",
    tags: ["ops"],
  });

  // both turns are rendered, and an empty side is marked rather than dropped
  const prompt = llm.prompts[0] ?? "";
  assert.match(prompt, /--- Turn 1 ---/);
  assert.match(prompt, /--- Turn 2 ---/);
  assert.match(prompt, /User: \(empty\)/);
  assert.match(prompt, /I live in Lisbon/);
});

test("the extraction model overrides the default, and falls back to it", async () => {
  llm.queue.push(jsonResult({ userFacts: [] }));
  env.MEMORY_EXTRACT_MODEL = "cheap-model";
  await extract.extractMemory([{ userText: "a", assistantText: "b" }]);
  assert.equal(llm.modelIds[0], "cheap-model");

  llm.queue.push(jsonResult({ userFacts: [] }));
  env.MEMORY_EXTRACT_MODEL = undefined;
  await extract.extractMemory([{ userText: "a", assistantText: "b" }]);
  assert.equal(llm.modelIds[1], env.LLM_DEFAULT_MODEL);
});

test("a model failure degrades to an empty extraction", async () => {
  llm.queue.push(new Error("provider exploded"));
  assert.deepEqual(
    await extract.extractMemory([
      {
        userText: "remember me",
        assistantText: "ok",
        userId: "u1",
        guildId: "g1",
        conversationId: "conv-1",
      },
    ]),
    { userFacts: [] }
  );
});

test("enqueueing refuses disabled extraction and empty turns", () => {
  env.MEMORY_EXTRACT_MODEL = "disabled";
  assert.equal(
    extract.enqueueMemoryExtraction({ userText: "x", assistantText: "y" }),
    false
  );

  env.MEMORY_EXTRACT_MODEL = undefined;
  assert.equal(
    extract.enqueueMemoryExtraction({ userText: " ", assistantText: "" }),
    false
  );
});

test("a conversation flushes once idle, grouped by speaker", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  llm.queue.push(
    jsonResult({ userFacts: [{ fact: "u1 fact" }] }),
    jsonResult({ userFacts: [{ fact: "u2 fact" }] })
  );

  const base = {
    conversationId: "conv-shared",
    guildId: "g-shared",
    channelId: "c-shared",
  };
  assert.equal(
    extract.enqueueMemoryExtraction({
      ...base,
      userId: "u1",
      userText: "first",
      assistantText: "ack",
      sourceMessageId: 1,
    }),
    true
  );
  extract.enqueueMemoryExtraction({
    ...base,
    userId: "u2",
    userText: "second",
    assistantText: "ack",
    sourceMessageId: 2,
  });
  extract.enqueueMemoryExtraction({
    ...base,
    userId: "u1",
    userText: "third",
    assistantText: "ack",
    sourceMessageId: 3,
  });

  await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
  await drainMicrotasks();

  assert.equal(stored.calls.length, 2);
  const byUser = new Map(stored.calls.map((c) => [c.userId, c]));
  const first = byUser.get("u1");
  const second = byUser.get("u2");
  assert.ok(first && second);
  assert.equal(first.sourceConversationId, "conv-shared");
  assert.equal(first.guildId, "g-shared");
  assert.equal(first.channelId, "c-shared");
  // attribution follows the speaker's last turn, not the channel's
  assert.equal(first.sourceMessageId, 3);
  assert.equal(second.sourceMessageId, 2);
  assert.deepEqual(
    (first.extraction as { userFacts: { fact: string }[] }).userFacts,
    [{ fact: "u1 fact", confidence: undefined }]
  );

  // u1 spoke twice, so their extraction saw both turns
  assert.match(llm.prompts.join("\n"), /--- Turn 2 ---/);
});

test("each new turn pushes the idle deadline back", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  llm.queue.push(jsonResult({ userFacts: [] }));

  extract.enqueueMemoryExtraction({
    conversationId: "conv-chatty",
    userId: "u1",
    userText: "one",
    assistantText: "ack",
  });
  await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1000);
  assert.equal(stored.calls.length, 0);

  extract.enqueueMemoryExtraction({
    conversationId: "conv-chatty",
    userId: "u1",
    userText: "two",
    assistantText: "ack",
  });
  await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1000);
  assert.equal(stored.calls.length, 0);

  await vi.advanceTimersByTimeAsync(1000);
  await drainMicrotasks();
  assert.equal(stored.calls.length, 1);
});

test("a turn without a conversation id still flushes under a generated one", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  llm.queue.push(jsonResult({ userFacts: [{ fact: "anonymous convo" }] }));

  extract.enqueueMemoryExtraction({
    userText: "no conversation id",
    assistantText: "still buffered",
  });

  await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
  await drainMicrotasks();

  assert.equal(stored.calls.length, 1);
  const call = stored.calls[0];
  assert.ok(call);
  // no userId on the turn: the empty group key becomes a null author
  assert.equal(call.userId, null);
  assert.match(
    String(call.sourceConversationId),
    /^[0-9a-f-]{36}$/ // crypto.randomUUID
  );
});

test("a failing store is logged instead of surfacing as an unhandled rejection", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  llm.queue.push(jsonResult({ userFacts: [{ fact: "doomed" }] }));
  stored.fail = true;

  const warnings: unknown[] = [];
  const realWarn = logger.warn;
  logger.warn = ((message: unknown) => {
    warnings.push(message);
  }) as typeof logger.warn;

  try {
    extract.enqueueMemoryExtraction({
      conversationId: "conv-broken",
      userId: "u1",
      userText: "store me",
      assistantText: "ack",
    });
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    await drainMicrotasks();
  } finally {
    logger.warn = realWarn;
  }

  assert.ok(warnings.includes("memory extraction flush failed"));
});
