import assert from "node:assert/strict";
import {
  APICallError,
  type LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { Client } from "discord.js";
import { afterEach, test, vi } from "vitest";
import { z } from "zod";
import { bootstrapTestEnv, MISSING_MCP_CONFIG } from "../../helpers/setup.js";

// Failure and edge paths of the chat loop: what the user is told when the model
// stops for a reason that isn't "stop", what happens at the context wall, and
// what the turn does with the numbers the provider hands back.
const facts = vi.hoisted(() => ({ fetchUserFacts: vi.fn() }));
vi.mock("../../../src/ai/memory/user-facts.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/ai/memory/user-facts.js")
    >();
  return { ...actual, fetchUserFacts: facts.fetchUserFacts };
});

bootstrapTestEnv();
process.env.MCP_CONFIG_PATH = MISSING_MCP_CONFIG;
process.env.TOOL_DM_RULES =
  "discord,persona,memory,topic,logbook,web,scheduler,heartbeat,shell,mcp,user-input,skills";

const { chat, ContextWindowFullError } = await import(
  "../../../src/ai/llm/streaming.js"
);
const { env } = await import("../../../src/config/env.js");
const { initAccessConfig } = await import("../../../src/config/access.js");
const { logger } = await import("../../../src/config/logger.js");
const { runMigrations } = await import("../../../src/db/migrate.js");

initAccessConfig(env);
await runMigrations();
facts.fetchUserFacts.mockResolvedValue([]);

const fakeClient = {} as Client;
const toolContext = {
  client: fakeClient,
  guildId: null,
  channelId: "channel",
  userId: null,
};

type Usage = LanguageModelV3GenerateResult["usage"];

function usage(
  over: Partial<{
    input: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  }> = {}
): Usage {
  const input = over.input ?? 10;
  return {
    inputTokens: {
      total: input,
      noCache: input,
      cacheRead: over.cacheRead ?? 0,
      cacheWrite: over.cacheWrite ?? 0,
    },
    outputTokens: { total: 5, text: 5, reasoning: over.reasoning ?? 0 },
  } as Usage;
}

type Finish = LanguageModelV3GenerateResult["finishReason"]["unified"];

function textResult(
  text: string,
  finishReason: Finish = "stop",
  over: Partial<LanguageModelV3GenerateResult> = {}
): LanguageModelV3GenerateResult {
  return {
    content: text ? [{ type: "text", text }] : [],
    finishReason: { unified: finishReason, raw: finishReason },
    usage: usage(),
    warnings: [],
    ...over,
  };
}

function toolCallResult(
  over: Partial<LanguageModelV3GenerateResult> = {}
): LanguageModelV3GenerateResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "lookup",
        input: JSON.stringify({ query: "answer" }),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool-calls" },
    usage: usage(),
    warnings: [],
    ...over,
  };
}

const lookupTool = {
  lookup: tool({
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }: { query: string }) => ({ query, found: true }),
  }),
};

/** Feeds a scripted list of generations to the model, one per call. */
function scriptedModel(results: LanguageModelV3GenerateResult[]) {
  let index = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      const next = results[index++] ?? results[results.length - 1];
      if (next instanceof Error) throw next;
      return next as LanguageModelV3GenerateResult;
    },
  });
}

function overflowError(): APICallError {
  return new APICallError({
    message: "prompt is too long: 300000 tokens > 200000 maximum",
    url: "https://api.example.invalid/v1/messages",
    requestBodyValues: {},
    statusCode: 400,
    isRetryable: false,
  });
}

const realWarn = logger.warn;
const realInfo = logger.info;
afterEach(() => {
  logger.warn = realWarn;
  logger.info = realInfo;
  facts.fetchUserFacts.mockReset().mockResolvedValue([]);
});

/** Collects the structured fields of one logger method while `fn` runs. */
async function captureLog<T>(
  level: "warn" | "info",
  fn: () => Promise<T>
): Promise<{ value: T; entries: Record<string, unknown>[] }> {
  const entries: Record<string, unknown>[] = [];
  const real = logger[level];
  logger[level] = ((_message: unknown, fields?: Record<string, unknown>) => {
    entries.push(fields ?? {});
  }) as typeof logger.warn;
  try {
    return { value: await fn(), entries };
  } finally {
    logger[level] = real;
  }
}

const run = (
  model: MockLanguageModelV3,
  over: Partial<Parameters<typeof chat>[0]> = {}
) =>
  chat({
    model,
    maxSteps: 3,
    messages: [{ role: "user", content: "hi" }],
    toolSet: {},
    toolContext,
    ...over,
  });

// finish reasons that aren't "stop"

test("a filtered response says so instead of trailing off", async () => {
  const result = await run(
    scriptedModel([textResult("partial", "content-filter")])
  );
  assert.match(result.text, /^partial/);
  assert.match(result.text, /safety filter interrupted the response/);
  assert.equal(result.finishReason, "content-filter");
});

test("a failed generation is labelled as such", async () => {
  const result = await run(scriptedModel([textResult("half", "error")]));
  assert.match(result.text, /generation failed/);
});

test("an unspecified provider stop is labelled too", async () => {
  const result = await run(scriptedModel([textResult("half", "other")]));
  assert.match(result.text, /unspecified provider reason/);
});

test("an empty response with an unmapped reason stays empty", async () => {
  const result = await run(
    scriptedModel([textResult("", "unknown" as unknown as Finish)])
  );
  assert.equal(result.text, "");
});

test("a notice with nothing in front of it carries no blank line", async () => {
  const result = await run(scriptedModel([textResult("", "error")]));
  assert.equal(result.text, "_(The model stopped because generation failed.)_");
});

// output-length continuation

test("a continuation that fails leaves the partial answer plus an explanation", async () => {
  const model = scriptedModel([
    textResult("first half", "length"),
    overflowError() as unknown as LanguageModelV3GenerateResult,
  ]);
  const { value, entries } = await captureLog("warn", () => run(model));

  assert.match(value.text, /^first half/);
  assert.match(value.text, /could not be continued/);
  assert.equal(value.finishReason, "continuation-error");
  assert.ok(entries.some((e) => "err" in e));
});

test("a continuation that fails for an unrelated reason is reported the same way", async () => {
  const model = scriptedModel([
    textResult("first half", "length"),
    new Error("socket hang up") as unknown as LanguageModelV3GenerateResult,
  ]);
  const result = await run(model);

  assert.match(result.text, /^first half/);
  assert.match(result.text, /could not be continued/);
});

test("output that keeps hitting the limit gives up after two continuations", async () => {
  const model = scriptedModel([
    textResult("a", "length"),
    textResult("b", "length"),
    textResult("c", "length"),
  ]);
  const result = await run(model);

  assert.match(result.text, /^abc/);
  assert.match(result.text, /repeatedly reaching the model's output limit/);
  // the original call plus two continuations, and one combined assistant message
  assert.equal(model.doGenerateCalls.length, 3);
  assert.equal(result.responseMessages.length, 1);
});

// context window

test("a prior turn already over the threshold is refused before spending tokens", async () => {
  const model = scriptedModel([textResult("never runs")]);
  await assert.rejects(
    run(model, { priorInputTokens: env.CONTEXT_WINDOW_SIZE - 1 }),
    (err: unknown) => {
      assert.ok(err instanceof ContextWindowFullError);
      assert.equal(err.retrySafe, true);
      return true;
    }
  );
  assert.equal(model.doGenerateCalls.length, 0);
});

test("a prior turn under the threshold proceeds normally", async () => {
  const result = await run(scriptedModel([textResult("fine")]), {
    priorInputTokens: 10,
  });
  assert.equal(result.text, "fine");
});

test("a provider overflow before any tool ran is safe to retry", async () => {
  const model = scriptedModel([
    overflowError() as unknown as LanguageModelV3GenerateResult,
  ]);
  await assert.rejects(run(model), (err: unknown) => {
    assert.ok(err instanceof ContextWindowFullError);
    assert.equal(err.retrySafe, true);
    return true;
  });
});

test("a provider overflow after a tool ran is not safe to retry", async () => {
  const model = scriptedModel([
    toolCallResult(),
    overflowError() as unknown as LanguageModelV3GenerateResult,
  ]);
  await assert.rejects(run(model, { toolSet: lookupTool }), (err: unknown) => {
    assert.ok(err instanceof ContextWindowFullError);
    assert.equal(err.retrySafe, false);
    return true;
  });
});

test("an overflow on the forced final answer surfaces as a context error", async () => {
  // one tool round, then the step limit forces a text-only call that overflows
  const model = scriptedModel([
    toolCallResult(),
    overflowError() as unknown as LanguageModelV3GenerateResult,
  ]);
  await assert.rejects(
    run(model, { maxSteps: 1, toolSet: lookupTool }),
    (err: unknown) => {
      assert.ok(err instanceof ContextWindowFullError);
      return true;
    }
  );
});

test("an unrelated provider error is not mistaken for an overflow", async () => {
  const boom = new APICallError({
    message: "invalid api key",
    url: "https://api.example.invalid/v1/messages",
    requestBodyValues: {},
    statusCode: 401,
    isRetryable: false,
  });
  await assert.rejects(
    run(scriptedModel([boom as unknown as LanguageModelV3GenerateResult])),
    /invalid api key/
  );
});

test("context pressure stops the tools but still produces an answer", async () => {
  // a huge input on the first step trips the pressure check even though the
  // step budget is nowhere near spent
  const model = scriptedModel([
    toolCallResult({ usage: usage({ input: env.CONTEXT_WINDOW_SIZE - 1 }) }),
    textResult("answering with what I have"),
  ]);
  const result = await run(model, { maxSteps: 10, toolSet: lookupTool });

  assert.equal(result.text, "answering with what I have");
  assert.equal(model.doGenerateCalls.length, 2);
  // the forced call carries no tools
  assert.equal(model.doGenerateCalls[1]?.tools, undefined);
});

// user facts

test("user facts are retrieved and ride on the newest message", async () => {
  facts.fetchUserFacts.mockResolvedValue(["Lives in NL", "Sails a skiff"]);
  const model = scriptedModel([textResult("noted")]);
  await run(model, { userId: "user-1" });

  const prompt = JSON.stringify(model.doGenerateCalls[0]?.prompt);
  assert.ok(prompt.includes("Memory: User Facts"));
  assert.ok(prompt.includes("Lives in NL"));
  assert.equal(facts.fetchUserFacts.mock.calls[0]?.[0]?.userId, "user-1");
});

test("a failing fact lookup does not take the turn down with it", async () => {
  facts.fetchUserFacts.mockRejectedValue(new Error("facts unavailable"));
  const { value, entries } = await captureLog("warn", () =>
    run(scriptedModel([textResult("still answered")]), { userId: "user-1" })
  );

  assert.equal(value.text, "still answered");
  assert.ok(entries.some((e) => "err" in e));
});

test("no user id means no fact lookup at all", async () => {
  await run(scriptedModel([textResult("ok")]));
  assert.equal(facts.fetchUserFacts.mock.calls.length, 0);
});

// turn context placement

test("this turn's context is prepended to a multi-part user message", async () => {
  const model = scriptedModel([textResult("saw it")]);
  await run(model, {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image",
            image: Buffer.from("png"),
            mediaType: "image/png",
          },
        ],
      },
    ],
  });

  const parts = model.doGenerateCalls[0]?.prompt.at(-1)?.content as Array<{
    type: string;
    text?: string;
  }>;
  // the context block is inserted ahead of the model's own parts, image intact
  assert.match(parts[0]?.text ?? "", /## Current Turn/);
  assert.equal(parts[1]?.text, "what is this?");
  assert.equal(parts[2]?.type, "file");
});

// provider bookkeeping

test("provider warnings are surfaced rather than swallowed", async () => {
  const model = scriptedModel([
    textResult("done", "stop", {
      warnings: [
        { type: "other", message: "too many cache_control blocks" },
      ] as LanguageModelV3GenerateResult["warnings"],
    }),
  ]);
  const { entries } = await captureLog("warn", () => run(model));

  assert.ok(
    entries.some((e) => JSON.stringify(e.warnings ?? "").includes("cache"))
  );
});

test("cache hits are reported with a hit rate", async () => {
  const model = scriptedModel([
    textResult("cached", "stop", {
      usage: usage({ input: 100, cacheRead: 300, cacheWrite: 100 }),
    }),
  ]);
  const { entries } = await captureLog("info", () => run(model));

  const cache = entries.find((e) => "hitRate" in e);
  assert.ok(cache, "expected a prompt cache log line");
  assert.equal(cache?.cacheRead, 300);
  assert.equal(cache?.cacheWrite, 100);
  // 300 read out of 500 billable
  assert.equal(cache?.hitRate, 60);
});

test("a provider that reports no cache detail logs nothing about caching", async () => {
  const { entries } = await captureLog("info", () =>
    run(scriptedModel([textResult("plain")]))
  );
  assert.ok(!entries.some((e) => "hitRate" in e));
});

test("a provider that omits the token breakdown still totals cleanly", async () => {
  // openai-compatible endpoints often report totals only; the accumulator has
  // to treat the missing detail as zero rather than NaN
  const bare = {
    inputTokens: { total: 12 },
    outputTokens: { total: 4 },
  } as Usage;
  const result = await run(
    scriptedModel([textResult("terse", "stop", { usage: bare })])
  );

  assert.equal(result.text, "terse");
  assert.equal(result.usage.inputTokens, 12);
  assert.equal(result.lastInputTokens, 12);
  assert.equal(result.usage.inputTokenDetails?.cacheReadTokens, 0);
  assert.equal(result.usage.inputTokenDetails?.noCacheTokens, 0);
});

test("provider-reported reasoning tokens are passed through unestimated", async () => {
  const events: Array<{ type: string; tokens?: number; estimated?: boolean }> =
    [];
  await run(
    scriptedModel([
      textResult("thought", "stop", { usage: usage({ reasoning: 128 }) }),
    ]),
    { onToolActivity: (e) => events.push(e) }
  );

  const reasoning = events.find((e) => e.type === "reasoning");
  assert.equal(reasoning?.tokens, 128);
  assert.equal(reasoning?.estimated, false);
});

// caller-supplied wiring

test("a caller abort signal is combined with the turn timeout", async () => {
  const controller = new AbortController();
  const model = scriptedModel([textResult("done")]);
  await run(model, { abortSignal: controller.signal });

  const signal = model.doGenerateCalls[0]?.abortSignal;
  assert.ok(signal, "the model call should carry an abort signal");
  assert.equal(signal.aborted, false);
  // aborting the caller's controller must reach the combined signal
  controller.abort();
  assert.equal(signal.aborted, true);
});

test("with no tool-set override the real Discord tool set is built", async () => {
  const model = scriptedModel([textResult("built")]);
  const result = await chat({
    model,
    maxSteps: 1,
    messages: [{ role: "user", content: "hi" }],
    // a guild channel, so TOOL_DM_RULES doesn't strip everything
    toolContext: { ...toolContext, guildId: "guild-1" },
  });

  assert.equal(result.text, "built");
  const tools = model.doGenerateCalls[0]?.tools ?? [];
  assert.ok(tools.length > 0, "expected the built-in tools to be present");
  assert.ok(tools.some((t) => t.name === "web_search"));
});
