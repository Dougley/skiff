import assert from "node:assert/strict";
import test from "node:test";
import type { ToolActivityEvent } from "../src/ai/llm/streaming.js";
import { createLatestUpdateQueue } from "../src/utils/latest-update-queue.js";

process.env.DISCORD_BOT_TOKEN = `${Buffer.from("123456789012345678").toString("base64")}.test.signature`;
process.env.OPENAI_API_KEY = "test";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.DATABASE_URL = "memory://";

test("preserves multiline text within one narration update", async () => {
  const { formatToolStatusMessage } = await import(
    "../src/utils/tool-status.js"
  );
  const events: ToolActivityEvent[] = [
    {
      type: "text",
      stepNumber: 0,
      text: "Okay, I'm working.\n\nHold on.",
    },
  ];

  const status = formatToolStatusMessage(events, false);

  assert.ok(status.includes("Okay, I'm working."));
  assert.ok(status.includes("Hold on."));
  assert.ok(status.indexOf("Okay, I'm working.") < status.indexOf("Hold on."));
});

test("new tool-round narration replaces older narration", async () => {
  const { formatToolStatusMessage } = await import(
    "../src/utils/tool-status.js"
  );
  const events: ToolActivityEvent[] = [
    { type: "text", stepNumber: 0, text: "Hold on." },
    { type: "text", stepNumber: 1, text: "Still working." },
  ];

  const status = formatToolStatusMessage(events, false);

  assert.ok(!status.includes("Hold on."));
  assert.ok(status.includes("Still working."));
});

test("folds reasoning into one cumulative tail count instead of per-step lines", async () => {
  const { formatToolStatusMessage } = await import(
    "../src/utils/tool-status.js"
  );
  const events: ToolActivityEvent[] = [
    { type: "reasoning", stepNumber: 0, tokens: 1000, estimated: false },
    {
      type: "tool",
      stepNumber: 0,
      toolName: "web_search",
      args: {},
      output: null,
    },
    { type: "reasoning", stepNumber: 1, tokens: 500, estimated: true },
    {
      type: "tool",
      stepNumber: 1,
      toolName: "fetch_url",
      args: {},
      output: null,
    },
  ];

  const status = formatToolStatusMessage(events, false);

  // one aggregate mention, not one line per reasoning step
  assert.equal(status.split("thinking tokens").length - 1, 1);
  // any estimated step marks the whole total as approximate
  assert.ok(status.includes("~1.5k thinking tokens"));

  const withoutReasoning = formatToolStatusMessage(
    events.filter((e) => e.type === "tool"),
    false
  );
  assert.ok(!withoutReasoning.includes("thinking tokens"));
});

test("done summary aggregates thinking tokens across steps", async () => {
  const { formatToolStatusMessage } = await import(
    "../src/utils/tool-status.js"
  );
  const events: ToolActivityEvent[] = [
    { type: "reasoning", stepNumber: 0, tokens: 800, estimated: false },
    {
      type: "tool",
      stepNumber: 0,
      toolName: "web_search",
      args: {},
      output: null,
    },
    { type: "reasoning", stepNumber: 1, tokens: 400, estimated: false },
  ];

  const status = formatToolStatusMessage(events, true);

  assert.ok(status.includes("Used 1 tool"));
  // exact counts get no approximation marker
  assert.ok(status.includes(" 1.2k thinking tokens"));
  assert.ok(!status.includes("~1.2k"));

  const noThinking = formatToolStatusMessage([events[1]!], true);
  assert.ok(!noThinking.includes("thinking tokens"));
});

test("serializes edits and drains the newest status before final replacement", async () => {
  const applied: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let releaseFirst: (() => void) | undefined;
  const firstBlocked = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const queue = createLatestUpdateQueue<string>(
    async (value) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      applied.push(value);
      if (applied.length === 1) await firstBlocked;
      concurrent--;
    },
    (error) => assert.fail(String(error))
  );

  queue.push("Okay, I'm working.");
  queue.push("Okay, I'm working.\n\nHold on.");
  queue.push("Okay, I'm working.\n\nHold on.\n\nStill working.");
  releaseFirst?.();
  await queue.flush();

  assert.equal(maxConcurrent, 1);
  assert.deepEqual(applied, [
    "Okay, I'm working.",
    "Okay, I'm working.\n\nHold on.\n\nStill working.",
  ]);
});
