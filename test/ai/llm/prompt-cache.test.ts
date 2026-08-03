import assert from "node:assert/strict";
import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import type { Client } from "discord.js";
import { test } from "vitest";
import { z } from "zod";
import { bootstrapTestEnv, MISSING_MCP_CONFIG } from "../../helpers/setup.js";

bootstrapTestEnv();
process.env.MCP_CONFIG_PATH = MISSING_MCP_CONFIG;
process.env.TOOL_DM_RULES = "discord";

const { chat } = await import("../../../src/ai/llm/streaming.js");
const { buildTurnContext, getSystemPrompt } = await import(
  "../../../src/ai/llm/system-prompt.js"
);
const { env } = await import("../../../src/config/env.js");
const { initAccessConfig } = await import("../../../src/config/access.js");

initAccessConfig(env);

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

const reply = (text: string): LanguageModelV3GenerateResult => ({
  content: [{ type: "text", text }],
  finishReason: { unified: "stop", raw: "stop" },
  usage,
  warnings: [],
});

const toolContext = {
  client: {} as Client,
  guildId: null,
  channelId: "channel",
  userId: null,
};

type PromptMessage = {
  role: string;
  content: unknown;
  providerOptions?: Record<string, unknown>;
};

/** Runs one turn and hands back the prompt the provider actually received. */
async function promptFor(
  messages: Array<{ role: "user" | "assistant"; content: string }>,
  extra: { logbookContext?: string[] } = {}
): Promise<PromptMessage[]> {
  const model = new MockLanguageModelV3({
    doGenerate: async () => reply("ok"),
  });
  await chat({
    model,
    messages,
    toolSet: {},
    toolContext,
    ...extra,
  });
  return model.doGenerateCalls[0]?.prompt as unknown as PromptMessage[];
}

const hasCacheControl = (m: PromptMessage | undefined) =>
  (m?.providerOptions?.anthropic as { cacheControl?: unknown } | undefined)
    ?.cacheControl !== undefined;

/**
 * The message-level breakpoint. The stable system block carries one too, so
 * this searches only the conversation, from the back.
 */
function cacheBreakpointIndex(prompt: PromptMessage[]): number {
  const firstNonSystem = prompt.findIndex((m) => m.role !== "system");
  if (firstNonSystem === -1) return -1;
  for (let i = prompt.length - 1; i >= firstNonSystem; i--) {
    if (hasCacheControl(prompt[i])) return i;
  }
  return -1;
}

/**
 * Every breakpoint the provider sees for one call: system blocks, messages,
 * and tool definitions alike all draw from the same budget of 4.
 */
function totalBreakpoints(generateCall: unknown): number {
  const call = generateCall as {
    prompt: PromptMessage[];
    tools?: Array<{ providerOptions?: Record<string, unknown> }>;
  };
  const inPrompt = call.prompt.filter(hasCacheControl).length;
  const inTools = (call.tools ?? []).filter((t) =>
    hasCacheControl(t as PromptMessage)
  ).length;
  return inPrompt + inTools;
}

/**
 * The cached prefix as Anthropic sees it. `cache_control` marks where a
 * breakpoint sits but isn't part of the cached content, so comparing prefixes
 * across turns has to ignore it — the breakpoint legitimately moves forward
 * as the conversation grows.
 */
function cachedPrefix(prompt: PromptMessage[], upTo: number): string {
  return JSON.stringify(
    prompt.slice(0, upTo + 1).map(({ role, content }) => ({ role, content }))
  );
}

// how conversation-turn assembles the newest message: a sender block that is
// never persisted, so history replays without it
const senderBlock = JSON.stringify({
  sender: { display_name: "Remco", username: "remco", user_id: "1" },
});
const current = (text: string) => ({
  role: "user" as const,
  content: `${senderBlock}\n${text}`,
});

const HISTORY = [
  { role: "user" as const, content: "first question" },
  { role: "assistant" as const, content: "first answer" },
  { role: "user" as const, content: "second question" },
  { role: "assistant" as const, content: "second answer" },
];

test("the system prompt carries no clock", () => {
  const { stable, variable } = getSystemPrompt({ model: "gpt-4o-mini" });
  assert.doesNotMatch(stable, /Current time/);
  assert.doesNotMatch(variable, /Current time/);
  // the model name still belongs there — it only changes on /model
  assert.match(variable, /Model: gpt-4o-mini/);
});

test("per-turn context carries the clock, storylines, and facts", () => {
  const block = buildTurnContext({
    now: new Date("2026-08-02T14:31:00.000Z"),
    logbookContext: ["Shipping the retry work"],
    userFacts: ["Prefers concise answers"],
  });
  assert.match(block ?? "", /Current time: 2026-08-02T14:31:00.000Z/);
  assert.match(block ?? "", /Shipping the retry work/);
  assert.match(block ?? "", /Prefers concise answers/);
});

test("the breakpoint sits on the last stored message, not the newest", async () => {
  const prompt = await promptFor([...HISTORY, current("third question")]);
  const index = cacheBreakpointIndex(prompt);

  assert.notEqual(index, -1, "a breakpoint should exist");
  assert.equal(
    index,
    prompt.length - 2,
    "the newest message must stay outside the cached prefix"
  );
  assert.equal(
    JSON.stringify(prompt[index]?.content),
    JSON.stringify(prompt[prompt.length - 2]?.content)
  );
});

test("turn-varying context rides on the newest message", async () => {
  const prompt = await promptFor([...HISTORY, current("third question")], {
    logbookContext: ["Shipping the retry work"],
  });
  const newest = JSON.stringify(prompt.at(-1)?.content);

  assert.match(newest, /Current time/);
  assert.match(newest, /Shipping the retry work/);
  // and nowhere in the cached prefix
  const prefix = cachedPrefix(prompt, cacheBreakpointIndex(prompt));
  assert.doesNotMatch(prefix, /Current time/);
  assert.doesNotMatch(prefix, /Shipping the retry work/);
});

test("the next turn's prefix still matches what the last turn cached", async () => {
  // turn N — the newest message carries a sender block that is never stored
  const first = await promptFor([...HISTORY, current("third question")], {
    logbookContext: ["Storyline as retrieved for this message"],
  });
  const breakpoint = cacheBreakpointIndex(first);
  const cached = cachedPrefix(first, breakpoint);

  // turn N+1 — turn N's message replays from the database WITHOUT the sender
  // block, and retrieval returns something different for the new message
  const second = await promptFor(
    [
      ...HISTORY,
      { role: "user", content: "third question" },
      { role: "assistant", content: "ok" },
      current("fourth question"),
    ],
    { logbookContext: ["A completely different storyline"] }
  );

  assert.equal(
    cachedPrefix(second, breakpoint),
    cached,
    "everything up to the previous breakpoint must be byte-identical, or the whole history is re-billed"
  );
});

test("a first message with no history gets no message breakpoint", async () => {
  const prompt = await promptFor([current("hello")]);
  assert.equal(cacheBreakpointIndex(prompt), -1);
});

test("a multi-step turn caches its own accumulated tail", async () => {
  // step 1 calls a tool, step 2 answers — so step 2 replays step 1's
  // assistant + tool messages and should read them from cache instead of
  // re-billing them
  let call = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      call++;
      if (call === 1) {
        return {
          content: [
            {
              type: "tool-call" as const,
              toolCallId: "c1",
              toolName: "ping",
              input: "{}",
            },
          ],
          finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
          usage,
          warnings: [],
        } as LanguageModelV3GenerateResult;
      }
      return reply("done");
    },
  });

  await chat({
    model,
    messages: [...HISTORY, current("third question")],
    toolSet: {
      ping: {
        description: "ping",
        inputSchema: z.object({}),
        execute: async () => "pong",
      },
    } as unknown as Parameters<typeof chat>[0]["toolSet"],
    toolContext,
  });

  const first = model.doGenerateCalls[0]?.prompt as unknown as PromptMessage[];
  const second = model.doGenerateCalls[1]?.prompt as unknown as PromptMessage[];

  // conversation breakpoints only — the stable system block carries its own
  const marked = (p: PromptMessage[]) =>
    p
      .map((m, i) => (m.role !== "system" && hasCacheControl(m) ? i : -1))
      .filter((i) => i !== -1);

  // step 1 has produced nothing of its own yet: history breakpoint only
  assert.deepEqual(marked(first), [first.length - 2]);

  // step 2 adds one on the newest message — the tool result it just appended
  assert.deepEqual(marked(second), [first.length - 2, second.length - 1]);
  assert.ok(
    second.length > first.length,
    "step 2 must actually carry the step-1 messages"
  );

  // Anthropic honours 4 breakpoints and silently ignores the rest, so this is
  // the worst case: stable system + history + tail + last tool. A fifth would
  // be dropped by the provider with only a warning to show for it.
  assert.equal(
    totalBreakpoints(model.doGenerateCalls[1]),
    4,
    "a multi-step turn with tools sits exactly on Anthropic's breakpoint budget"
  );
});

test("a length continuation stays inside the breakpoint budget", async () => {
  // finishReason 'length' drives generateTextOnly, which appends a hidden
  // continuation prompt to the message list on every pass
  let call = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      call++;
      return {
        content: [{ type: "text" as const, text: `part ${call} ` }],
        finishReason:
          call < 3
            ? { unified: "length" as const, raw: "max_tokens" }
            : { unified: "stop" as const, raw: "stop" },
        usage,
        warnings: [],
      } as LanguageModelV3GenerateResult;
    },
  });

  await chat({
    model,
    messages: [...HISTORY, current("third question")],
    toolSet: {},
    toolContext,
  });

  assert.ok(model.doGenerateCalls.length > 1, "a continuation must have run");
  for (const [i, generateCall] of model.doGenerateCalls.entries()) {
    assert.ok(
      totalBreakpoints(generateCall) <= 4,
      `continuation call ${i} exceeded the breakpoint budget`
    );
  }
});

test("images survive the turn-context prepend", async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => reply("ok"),
  });
  await chat({
    model,
    messages: [
      ...HISTORY,
      {
        role: "user",
        content: [
          { type: "text", text: `${senderBlock}\nwhat is this` },
          { type: "image", image: Buffer.from("fake"), mediaType: "image/png" },
        ],
      },
    ],
    toolSet: {},
    toolContext,
  });

  const prompt = model.doGenerateCalls[0]?.prompt as unknown as PromptMessage[];
  const parts = prompt.at(-1)?.content as Array<{
    type: string;
    text?: string;
  }>;
  assert.equal(parts[0]?.type, "text");
  assert.match(parts[0]?.text ?? "", /Current time/);
  assert.ok(
    parts.some((p) => p.type === "file" || p.type === "image"),
    "the image part must still be there"
  );
});
