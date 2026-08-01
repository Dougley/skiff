import assert from "node:assert/strict";
import test from "node:test";
import {
  APICallError,
  type LanguageModelV3GenerateResult,
} from "@ai-sdk/provider";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { Client } from "discord.js";
import { z } from "zod";

process.env.DISCORD_BOT_TOKEN = `${Buffer.from("123456789012345678").toString("base64")}.test.signature`;
process.env.OPENAI_API_KEY = "test";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.DATABASE_URL = "memory://";
process.env.MCP_CONFIG_PATH = "/tmp/skiff-test-missing-mcp.json";
process.env.TOOL_DM_RULES = "discord";

const { chat } = await import("../src/ai/llm/streaming.js");
const { env } = await import("../src/config/env.js");
const { llmMaxRetries, retryLoggingFetch } = await import(
  "../src/ai/llm/retry.js"
);
const { logger } = await import("../src/config/logger.js");
const { initAccessConfig } = await import("../src/config/access.js");

initAccessConfig(env);

/** Runs `fn` with fetch and logger.warn stubbed, returning the warnings raised. */
async function captureWarnings(
  fetchImpl: typeof globalThis.fetch,
  fn: () => Promise<unknown>
): Promise<Record<string, unknown>[]> {
  const warnings: Record<string, unknown>[] = [];
  const realFetch = globalThis.fetch;
  const realWarn = logger.warn;
  globalThis.fetch = fetchImpl;
  logger.warn = ((_message: unknown, fields?: Record<string, unknown>) => {
    warnings.push(fields ?? {});
  }) as typeof logger.warn;
  try {
    await fn().catch(() => undefined);
  } finally {
    globalThis.fetch = realFetch;
    logger.warn = realWarn;
  }
  return warnings;
}

const OK = () => new Response("{}", { status: 200 });

const fakeClient = {} as Client;

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

/**
 * A transient upstream failure. `retry-after-ms` keeps the backoff at ~1ms —
 * the SDK honours it over exponential backoff, which is worth pinning on its
 * own and keeps this suite from sleeping for six seconds.
 */
function blip(): APICallError {
  return new APICallError({
    message: "upstream blip",
    url: "https://example.invalid/v1/chat",
    requestBodyValues: {},
    statusCode: 503,
    responseHeaders: { "retry-after-ms": "1" },
    isRetryable: true,
  });
}

function permanentFailure(): APICallError {
  return new APICallError({
    message: "bad request",
    url: "https://example.invalid/v1/chat",
    requestBodyValues: {},
    statusCode: 400,
    isRetryable: false,
  });
}

const baseToolContext = {
  client: fakeClient,
  guildId: null,
  channelId: "channel",
  userId: null,
};

test("the default policy is three attempts", () => {
  assert.equal(llmMaxRetries(), 2);
});

test("a turn survives blips up to the retry budget", async () => {
  env.LLM_MAX_RETRIES = 2;
  let attempts = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      attempts++;
      if (attempts <= 2) throw blip();
      return textResult("recovered");
    },
  });

  const result = await chat({
    model,
    messages: [{ role: "user", content: "hi" }],
    toolSet: {},
    toolContext: baseToolContext,
  });

  assert.equal(result.text, "recovered");
  assert.equal(model.doGenerateCalls.length, 3);
});

test("a blip that outlasts the budget still surfaces", async () => {
  env.LLM_MAX_RETRIES = 2;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      throw blip();
    },
  });

  await assert.rejects(
    chat({
      model,
      messages: [{ role: "user", content: "hi" }],
      toolSet: {},
      toolContext: baseToolContext,
    })
  );
  assert.equal(model.doGenerateCalls.length, 3);
});

test("a non-retryable error fails on the first attempt", async () => {
  env.LLM_MAX_RETRIES = 2;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      throw permanentFailure();
    },
  });

  await assert.rejects(
    chat({
      model,
      messages: [{ role: "user", content: "hi" }],
      toolSet: {},
      toolContext: baseToolContext,
    })
  );
  assert.equal(model.doGenerateCalls.length, 1);
});

test("retrying a step does not re-execute tools that already ran", async () => {
  env.LLM_MAX_RETRIES = 2;
  let executions = 0;
  let attempts = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      attempts++;
      // step 1: call the tool. step 2: blip once, then answer.
      if (attempts === 1) {
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "call-1",
              toolName: "lookup",
              input: JSON.stringify({ query: "x" }),
            },
          ],
          finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
          usage,
          warnings: [],
        };
      }
      if (attempts === 2) throw blip();
      return textResult("done");
    },
  });

  const result = await chat({
    model,
    messages: [{ role: "user", content: "look it up" }],
    toolSet: {
      lookup: tool({
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          executions++;
          return { query, found: true };
        },
      }),
    },
    toolContext: baseToolContext,
  });

  assert.equal(result.text, "done");
  assert.equal(model.doGenerateCalls.length, 3);
  assert.equal(executions, 1);
});

test("a blip that recovers still leaves a trace", async () => {
  const warnings = await captureWarnings(
    async () => new Response("overloaded", { status: 503 }),
    () => retryLoggingFetch("https://api.example.invalid/v1/messages")
  );

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.status, 503);
  assert.equal(warnings[0]?.url, "https://api.example.invalid/v1/messages");
});

test("a connection failure is logged and rethrown untouched", async () => {
  const failure = new TypeError("fetch failed");
  let thrown: unknown;
  const warnings = await captureWarnings(
    async () => {
      throw failure;
    },
    () =>
      retryLoggingFetch("https://api.example.invalid/v1/messages").catch(
        (err) => {
          thrown = err;
          throw err;
        }
      )
  );

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.err, failure);
  assert.equal(thrown, failure);
});

test("healthy and permanently-failed calls stay quiet", async () => {
  // 200 is fine; 400 is the call site's to report, and logging it here would
  // double up on an error that was never going to be retried
  for (const status of [200, 400, 401, 404]) {
    const warnings = await captureWarnings(
      async () => new Response("{}", { status }),
      () => retryLoggingFetch("https://api.example.invalid/v1/messages")
    );
    assert.equal(warnings.length, 0, `status ${status} should not warn`);
  }
});

test("an aborted call is the caller's decision, not an upstream blip", async () => {
  const warnings = await captureWarnings(
    async () => {
      throw new DOMException("aborted", "AbortError");
    },
    () => retryLoggingFetch("https://api.example.invalid/v1/messages")
  );

  assert.equal(warnings.length, 0);
});

test("the logged url keeps host and path but drops the query string", async () => {
  const warnings = await captureWarnings(
    async () => new Response("slow down", { status: 429 }),
    () =>
      retryLoggingFetch(
        "https://api.example.invalid/v1/messages?api_key=secret&x=1"
      )
  );

  assert.equal(warnings[0]?.url, "https://api.example.invalid/v1/messages");
});

test("responses pass through the wrapper unchanged", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = OK;
  try {
    const response = await retryLoggingFetch("https://api.example.invalid/v1");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "{}");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("LLM_MAX_RETRIES of 0 disables retries", async () => {
  env.LLM_MAX_RETRIES = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      throw blip();
    },
  });

  await assert.rejects(
    chat({
      model,
      messages: [{ role: "user", content: "hi" }],
      toolSet: {},
      toolContext: baseToolContext,
    })
  );
  assert.equal(model.doGenerateCalls.length, 1);
  env.LLM_MAX_RETRIES = 2;
});
