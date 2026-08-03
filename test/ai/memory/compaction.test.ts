import assert from "node:assert/strict";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv({ LLM_MAX_RETRIES: "0", CONTEXT_WINDOW_SIZE: "1000" });

const llm = vi.hoisted(() => ({
  queue: [] as (LanguageModelV3GenerateResult | Error)[],
  modelIds: [] as (string | undefined)[],
  prompts: [] as string[],
  /** Awaited inside doGenerate when set — lets a call be held open. */
  gate: null as Promise<void> | null,
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
          if (llm.gate) await llm.gate;
          const next = llm.queue.shift();
          if (next === undefined) throw new Error("llm mock queue is empty");
          if (next instanceof Error) throw next;
          return next;
        },
      });
    },
  };
});

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function textResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  };
}

let compaction: typeof import("../../../src/ai/memory/compaction.js");
let dbm: typeof import("../../../src/db/index.js");
let env: typeof import("../../../src/config/env.js").env;

beforeAll(async () => {
  const [{ runMigrations }, compactionModule, dbModule, envModule] =
    await Promise.all([
      import("../../../src/db/migrate.js"),
      import("../../../src/ai/memory/compaction.js"),
      import("../../../src/db/index.js"),
      import("../../../src/config/env.js"),
    ]);
  await runMigrations();
  compaction = compactionModule;
  dbm = dbModule;
  env = envModule.env;
});

beforeEach(() => {
  llm.queue.length = 0;
  llm.modelIds.length = 0;
  llm.prompts.length = 0;
  llm.gate = null;
});

afterEach(() => {
  env.MEMORY_EXTRACT_MODEL = undefined;
});

let channelSeq = 0;

async function seedConversation(): Promise<string> {
  channelSeq++;
  const [conversation] = await dbm.db
    .insert(dbm.conversations)
    .values({ channelId: `compaction-${channelSeq}`, model: "test" })
    .returning();
  assert.ok(conversation);
  return conversation.id;
}

/** Inserts `contents.length` messages, alternating roles. */
async function seedMessages(
  conversationId: string,
  contents: (string | null)[]
): Promise<number[]> {
  const rows = await dbm.db
    .insert(dbm.messages)
    .values(
      contents.map((content, i) => ({
        conversationId,
        role: i % 2 === 0 ? "user" : "assistant",
        content,
      }))
    )
    .returning({ id: dbm.messages.id });
  return rows.map((r) => r.id);
}

async function conversationRow(id: string) {
  const [row] = await dbm.db
    .select()
    .from(dbm.conversations)
    .where(eq(dbm.conversations.id, id));
  return row;
}

test("compaction triggers only past half the context window", () => {
  // CONTEXT_WINDOW_SIZE is 1000 here, so the trigger sits at 500
  assert.equal(compaction.shouldCompact(null), false);
  assert.equal(compaction.shouldCompact(undefined), false);
  assert.equal(compaction.shouldCompact(0), false);
  assert.equal(compaction.shouldCompact(500), false);
  assert.equal(compaction.shouldCompact(501), true);
  assert.equal(compaction.shouldCompact(env.CONTEXT_WINDOW_SIZE), true);
});

test("an unknown conversation compacts to nothing", async () => {
  assert.equal(
    await compaction.compactConversation(crypto.randomUUID()),
    false
  );
  assert.equal(llm.modelIds.length, 0);
});

test("a conversation short enough to keep verbatim is left alone", async () => {
  const conversationId = await seedConversation();
  await seedMessages(conversationId, ["a", "b", "c", "d"]);

  assert.equal(await compaction.compactConversation(conversationId), false);
  assert.equal(llm.modelIds.length, 0);
  assert.equal((await conversationRow(conversationId))?.summary, null);
});

test("older messages fold into a summary while the tail stays verbatim", async () => {
  const conversationId = await seedConversation();
  const ids = await seedMessages(conversationId, [
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
  ]);
  llm.queue.push(textResult("  They counted to ten.  "));

  assert.equal(await compaction.compactConversation(conversationId), true);

  const row = await conversationRow(conversationId);
  assert.equal(row?.summary, "They counted to ten.");
  // the last four rows are kept, so the checkpoint lands on the sixth message
  assert.equal(row?.summaryUpToMessageId, ids[5]);

  const prompt = llm.prompts[0] ?? "";
  assert.match(prompt, /user: one/);
  assert.match(prompt, /assistant: six/);
  // the kept tail must not be in the summarized transcript
  assert.doesNotMatch(prompt, /user: seven/);
  assert.doesNotMatch(prompt, /Previous summary/);
});

test("a second pass folds the old summary in and only reads new messages", async () => {
  const conversationId = await seedConversation();
  const ids = await seedMessages(conversationId, [
    "old-1",
    "old-2",
    "old-3",
    "old-4",
    "old-5",
    "old-6",
  ]);
  llm.queue.push(textResult("First summary."));
  await compaction.compactConversation(conversationId);
  assert.equal(
    (await conversationRow(conversationId))?.summaryUpToMessageId,
    ids[1]
  );

  const newIds = await seedMessages(conversationId, [
    "new-1",
    "new-2",
    "new-3",
    "new-4",
    "new-5",
    "new-6",
  ]);
  llm.queue.push(textResult("Second summary."));
  assert.equal(await compaction.compactConversation(conversationId), true);

  const row = await conversationRow(conversationId);
  assert.equal(row?.summary, "Second summary.");
  // four old messages sat past the first checkpoint, so the second pass
  // compacts those plus the first two new ones and keeps the last four
  assert.equal(row?.summaryUpToMessageId, newIds[1]);

  const prompt = llm.prompts[1] ?? "";
  assert.match(prompt, /Previous summary/);
  assert.match(prompt, /First summary\./);
  // messages already folded into the previous summary are not re-sent
  assert.doesNotMatch(prompt, /old-1/);
  assert.match(prompt, /old-3/); // it sat after the first checkpoint
});

test("each message is truncated before it reaches the prompt", async () => {
  const conversationId = await seedConversation();
  await seedMessages(conversationId, [
    "z".repeat(5000),
    "b",
    "c",
    "d",
    "e",
    "f",
  ]);
  llm.queue.push(textResult("Long one."));

  assert.equal(await compaction.compactConversation(conversationId), true);
  const prompt = llm.prompts[0] ?? "";
  assert.ok(prompt.includes("z".repeat(4000)));
  assert.ok(!prompt.includes("z".repeat(4001)));
});

test("messages with no text produce no transcript and no model call", async () => {
  const conversationId = await seedConversation();
  await seedMessages(conversationId, [null, null, null, null, null, null]);

  assert.equal(await compaction.compactConversation(conversationId), false);
  assert.equal(llm.modelIds.length, 0);
  assert.equal((await conversationRow(conversationId))?.summary, null);
});

test("an empty summary is not written", async () => {
  const conversationId = await seedConversation();
  await seedMessages(conversationId, ["a", "b", "c", "d", "e", "f"]);
  llm.queue.push(textResult("   "));

  assert.equal(await compaction.compactConversation(conversationId), false);
  assert.equal((await conversationRow(conversationId))?.summary, null);
});

test("a model failure leaves the conversation untouched", async () => {
  const conversationId = await seedConversation();
  await seedMessages(conversationId, ["a", "b", "c", "d", "e", "f"]);
  llm.queue.push(new Error("summarizer exploded"));

  assert.equal(await compaction.compactConversation(conversationId), false);
  const row = await conversationRow(conversationId);
  assert.equal(row?.summary, null);
  assert.equal(row?.summaryUpToMessageId, null);
});

test("the extraction model is reused for summaries unless it is disabled", async () => {
  const conversationId = await seedConversation();
  await seedMessages(conversationId, ["a", "b", "c", "d", "e", "f"]);

  env.MEMORY_EXTRACT_MODEL = "summary-model";
  llm.queue.push(textResult("With the cheap model."));
  await compaction.compactConversation(conversationId);
  assert.equal(llm.modelIds[0], "summary-model");

  await seedMessages(conversationId, ["g", "h", "i", "j", "k", "l"]);
  env.MEMORY_EXTRACT_MODEL = "disabled";
  llm.queue.push(textResult("With the default model."));
  await compaction.compactConversation(conversationId);
  assert.equal(llm.modelIds[1], env.LLM_DEFAULT_MODEL);
});

test("a conversation already compacting refuses a second pass", async () => {
  const conversationId = await seedConversation();
  await seedMessages(conversationId, ["a", "b", "c", "d", "e", "f"]);

  let release: () => void = () => undefined;
  llm.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  llm.queue.push(textResult("Only one summary."));

  const first = compaction.compactConversation(conversationId);
  // the guard is synchronous up to the first await, so this lands mid-flight
  const second = await compaction.compactConversation(conversationId);
  release();

  assert.equal(await first, true);
  assert.equal(second, false);
  assert.equal(llm.prompts.length, 1);

  // and once it settles the same conversation can compact again
  llm.gate = null;
  await seedMessages(conversationId, ["m", "n", "o", "p", "q", "r"]);
  llm.queue.push(textResult("A later summary."));
  assert.equal(await compaction.compactConversation(conversationId), true);
});
