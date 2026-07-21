import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { Client } from "discord.js";
import { z } from "zod";

process.env.DISCORD_BOT_TOKEN = `${Buffer.from("123456789012345678").toString("base64")}.test.signature`;
process.env.OPENAI_API_KEY = "test";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.DATABASE_URL = "memory://";
process.env.MCP_CONFIG_PATH = "/tmp/skiff-test-missing-mcp.json";
process.env.TOOL_DM_RULES =
  "discord,persona,memory,topic,logbook,web,scheduler,heartbeat,shell,mcp,user-input,skills";

const usage = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: 0,
    cacheWrite: 0,
  },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

function textResult(
  text: string,
  finishReason: "stop" | "length"
): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: finishReason, raw: finishReason },
    usage,
    warnings: [],
  };
}

function toolCallResult(text?: string): LanguageModelV3GenerateResult {
  return {
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "lookup",
        input: JSON.stringify({ query: "answer" }),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool-calls" },
    usage,
    warnings: [],
  };
}

const fakeClient = {} as Client;

test("continues length-limited output and persists one combined answer", async () => {
  const [{ chat }, { env }, { initAccessConfig }] = await Promise.all([
    import("../src/ai/llm/streaming.js"),
    import("../src/config/env.js"),
    import("../src/config/access.js"),
  ]);
  initAccessConfig(env);

  const responses = [
    textResult("hello ", "length"),
    textResult("world", "stop"),
  ];
  let responseIndex = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () =>
      responses[responseIndex++] as LanguageModelV3GenerateResult,
  });
  const result = await chat({
    model,
    maxSteps: 0,
    messages: [{ role: "user", content: "say hello" }],
    toolSet: {},
    toolContext: {
      client: fakeClient,
      guildId: null,
      channelId: "channel",
      userId: null,
    },
  });

  assert.equal(result.text, "hello world");
  assert.equal(model.doGenerateCalls.length, 2);
  assert.equal(result.responseMessages.length, 1);
  assert.equal(result.responseMessages[0]?.role, "assistant");
  assert.equal(result.responseMessages[0]?.content, "hello world");
});

test("uses a text-only terminal generation after the tool-step limit", async () => {
  const [{ chat }, { env }, { initAccessConfig }] = await Promise.all([
    import("../src/ai/llm/streaming.js"),
    import("../src/config/env.js"),
    import("../src/config/access.js"),
  ]);
  initAccessConfig(env);

  const responses = [toolCallResult(), textResult("final answer", "stop")];
  let responseIndex = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () =>
      responses[responseIndex++] as LanguageModelV3GenerateResult,
  });
  const result = await chat({
    model,
    maxSteps: 1,
    messages: [{ role: "user", content: "look it up" }],
    toolSet: {
      lookup: tool({
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ query, found: true }),
      }),
    },
    toolContext: {
      client: fakeClient,
      guildId: null,
      channelId: "channel",
      userId: null,
    },
  });

  assert.equal(result.text, "final answer");
  assert.equal(model.doGenerateCalls.length, 2);
  assert.equal(model.doGenerateCalls[1]?.tools, undefined);
});

test("shows tool-round narration live but excludes it from the final answer", async () => {
  const [{ chat }, { env }, { initAccessConfig }] = await Promise.all([
    import("../src/ai/llm/streaming.js"),
    import("../src/config/env.js"),
    import("../src/config/access.js"),
  ]);
  initAccessConfig(env);

  const responses = [
    toolCallResult("Hold on."),
    toolCallResult("Still working."),
    textResult("Done.", "stop"),
  ];
  let responseIndex = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () =>
      responses[responseIndex++] as LanguageModelV3GenerateResult,
  });
  const activity: import("../src/ai/llm/streaming.js").ToolActivityEvent[] = [];
  const result = await chat({
    model,
    maxSteps: 3,
    messages: [{ role: "user", content: "do several things" }],
    toolSet: {
      lookup: tool({
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => ({ query, found: true }),
      }),
    },
    toolContext: {
      client: fakeClient,
      guildId: null,
      channelId: "channel",
      userId: null,
    },
    onToolActivity: (event) => activity.push(event),
  });

  assert.deepEqual(
    activity
      .filter((event) => event.type === "text")
      .map((event) => (event.type === "text" ? event.text : "")),
    ["Hold on.", "Still working."]
  );
  assert.equal(result.text, "Done.");
  assert.equal(model.doGenerateCalls.length, 3);
});
