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
