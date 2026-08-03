import assert from "node:assert/strict";
import { test, vi } from "vitest";

// Force the PNG conversion step to fail so renderLatex takes its
// render-failure fallback: the original fence must be restored verbatim.
vi.mock("sharp", () => ({
  default: () => {
    throw new Error("sharp exploded");
  },
}));

test("restores the original fence when rendering fails", async () => {
  const { renderLatex } = await import("../../src/utils/latex.js");

  const result = await renderLatex("Intro\n```latex\nx^2\n```\nOutro");

  assert.deepEqual(result.files, []);
  assert.equal(result.text, "Intro\n```latex\nx^2\n```\nOutro");
});

test("restored fences keep regex-special characters literal", async () => {
  const { renderLatex } = await import("../../src/utils/latex.js");

  // `$&` and `$1` are String.replace backreference syntax — the fallback
  // must reproduce them literally, not expand them.
  const result = await renderLatex("```latex\na $& b $1 c\n```");

  assert.deepEqual(result.files, []);
  assert.equal(result.text, "```latex\na $& b $1 c\n```");
});
