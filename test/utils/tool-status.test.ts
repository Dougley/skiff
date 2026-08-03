import assert from "node:assert/strict";
import { afterEach, beforeAll, test, vi } from "vitest";
import type { ToolActivityEvent } from "../../src/ai/llm/streaming.js";
import { bootstrapTestEnv } from "../helpers/setup.js";

bootstrapTestEnv();

let toolStatus: typeof import("../../src/utils/tool-status.js");
let EMOJI: typeof import("../../src/utils/emoji.js").EMOJI;

beforeAll(async () => {
  toolStatus = await import("../../src/utils/tool-status.js");
  ({ EMOJI } = await import("../../src/utils/emoji.js"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function toolEvent(
  toolName: string,
  output: unknown = null
): ToolActivityEvent {
  return { type: "tool", stepNumber: 0, toolName, args: {}, output };
}

test("emoji constants use Discord custom emoji syntax", async () => {
  const { EMOJI: emoji } = await import("../../src/utils/emoji.js");
  for (const value of Object.values(emoji)) {
    assert.match(value, /^<a?:\w+:\d+>$/);
  }
});

test("formatToolStatusLine knows built-in tools and falls back for others", () => {
  assert.equal(
    toolStatus.formatToolStatusLine("web_search"),
    "Searching the web"
  );
  assert.equal(
    toolStatus.formatToolStatusLine("mystery_tool"),
    "Using mystery_tool"
  );
});

test("renders a tree for a small number of tool calls", () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const status = toolStatus.formatToolStatusMessage(
    [toolEvent("web_search"), toolEvent("mystery_tool")],
    false
  );

  const lines = status.split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines[0]?.includes("╭"));
  assert.ok(lines[0]?.includes("Searching the web"));
  assert.ok(lines[1]?.includes("├"));
  // unknown tools get the generic tool emoji and label
  assert.ok(lines[1]?.includes(EMOJI.tool));
  assert.ok(lines[1]?.includes("Using mystery_tool"));
  assert.ok(lines[2]?.includes("╰"));
  assert.ok(lines[2]?.includes("Thinking..."));
});

test("collapses older events past the threshold", () => {
  const events = Array.from({ length: 7 }, (_, i) =>
    toolEvent(i % 2 === 0 ? "web_search" : "fetch_url")
  );
  const status = toolStatus.formatToolStatusMessage(events, false);

  assert.ok(status.includes("··· 5 earlier"));
  // only the two most recent tool lines are shown
  assert.equal(status.split("\n").filter((l) => l.includes("├")).length, 2);
});

test("narration is the progress line, not a status tool", () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const status = toolStatus.formatToolStatusMessage(
    [
      { type: "text", stepNumber: 0, text: "Deploying the fix" },
      toolEvent("web_search"),
    ],
    false
  );

  const lines = status.split("\n");
  assert.equal(lines[0], "Deploying the fix");
  assert.ok(lines.some((l) => l.includes("Searching the web")));
});

test("a pending retry outranks the loading line", () => {
  const events: ToolActivityEvent[] = [
    toolEvent("web_search"),
    { type: "retry", attempt: 1, status: 503, delayMs: 2000 },
  ];
  const status = toolStatus.formatToolStatusMessage(events, false);

  assert.ok(status.includes("Provider failed (503), trying again in 2s"));
});

test("a retry without an HTTP status reads as unreachable", () => {
  const events: ToolActivityEvent[] = [
    { type: "retry", attempt: 1, delayMs: 500 },
  ];
  const status = toolStatus.formatToolStatusMessage(events, false);

  assert.ok(status.includes("Provider unreachable, trying again in 500ms"));
});

test("fractional retry delays keep one decimal", () => {
  const events: ToolActivityEvent[] = [
    { type: "retry", attempt: 2, status: 429, delayMs: 1500 },
  ];
  const status = toolStatus.formatToolStatusMessage(events, false);

  assert.ok(status.includes("trying again in 1.5s"));
});

test("a retry that is no longer the last event is stale and hidden", () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const events: ToolActivityEvent[] = [
    { type: "retry", attempt: 1, status: 503, delayMs: 2000 },
    toolEvent("web_search"),
  ];
  const status = toolStatus.formatToolStatusMessage(events, false);

  assert.ok(!status.includes("trying again"));
  assert.ok(status.includes("Thinking..."));
});

test("with no tool events narration sits above the loading line", () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const status = toolStatus.formatToolStatusMessage(
    [{ type: "text", stepNumber: 0, text: "Reading the docs" }],
    false
  );

  assert.equal(status, `Reading the docs\n-# ${EMOJI.loading} Thinking...`);
});

test("narration longer than 500 characters is truncated with an ellipsis", () => {
  vi.spyOn(Math, "random").mockReturnValue(0);
  const events: ToolActivityEvent[] = [
    { type: "text", stepNumber: 0, text: "n".repeat(600) },
  ];
  const status = toolStatus.formatToolStatusMessage(events, false);

  const narration = status.split("\n")[0];
  assert.equal(narration, `${"n".repeat(500)}…`);
});

test("done summary pluralizes and appends the web-search caveat", () => {
  const none = toolStatus.formatToolStatusMessage([], true);
  assert.ok(none.includes("Used 0 tools"));

  const one = toolStatus.formatToolStatusMessage(
    [toolEvent("fetch_url")],
    true
  );
  assert.ok(one.includes("Used 1 tool"));
  assert.ok(!one.includes("Used 1 tools"));
  assert.ok(!one.includes("Web results"));

  const searched = toolStatus.formatToolStatusMessage(
    [toolEvent("web_search"), toolEvent("fetch_url")],
    true
  );
  assert.ok(searched.includes("Used 2 tools"));
  assert.ok(searched.includes("Web results may be inaccurate"));
});

test("token counts render plain under 1k and abbreviated above", () => {
  const under = toolStatus.formatToolStatusMessage(
    [{ type: "reasoning", stepNumber: 0, tokens: 999, estimated: false }],
    true
  );
  assert.ok(under.includes(" 999 thinking tokens"));

  const exact = toolStatus.formatToolStatusMessage(
    [{ type: "reasoning", stepNumber: 0, tokens: 1000, estimated: false }],
    true
  );
  assert.ok(exact.includes(" 1k thinking tokens"));
  assert.ok(!exact.includes("1.0k"));

  const fractional = toolStatus.formatToolStatusMessage(
    [{ type: "reasoning", stepNumber: 0, tokens: 2500, estimated: false }],
    true
  );
  assert.ok(fractional.includes(" 2.5k thinking tokens"));
});

// CONTEXT_WINDOW_SIZE keeps its 200,000 default here — overriding it in
// process.env would leak into any test file sharing this worker
test("formatContextUsage stays silent below the warning threshold", () => {
  assert.equal(toolStatus.formatContextUsage(140_000), null);
});

test("formatContextUsage warns between 75% and 95%", () => {
  const warning = toolStatus.formatContextUsage(160_000);
  assert.ok(warning);
  assert.ok(warning.includes("Memory 80% full"));
  assert.ok(warning.includes("(160,000 / 200,000 tokens)"));
});

test("formatContextUsage escalates at 95%", () => {
  const critical = toolStatus.formatContextUsage(192_000);
  assert.ok(critical);
  assert.ok(critical.includes("Running out of memory"));
  assert.ok(critical.includes("(96%)"));
  assert.ok(critical.includes("/clear"));
});
