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
const { llmMaxRetries } = await import("../src/ai/llm/retry.js");
const { initAccessConfig } = await import("../src/config/access.js");

initAccessConfig(env);

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
