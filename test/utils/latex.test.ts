import assert from "node:assert/strict";
import { test } from "vitest";
import { renderLatex } from "../../src/utils/latex.js";

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function assertIsPng(data: unknown): void {
  assert.ok(Buffer.isBuffer(data));
  assert.deepEqual(data.subarray(0, 8), PNG_MAGIC);
}

test("returns text unchanged when there is no latex fence", async () => {
  const input = "plain text mentioning latex but no fence";
  const result = await renderLatex(input);

  assert.equal(result.text, input);
  assert.deepEqual(result.files, []);
});

test("renders a latex fence to an attachment image", async () => {
  const result = await renderLatex("Before\n```latex\nx^2\n```\nAfter");

  assert.equal(result.files.length, 1);
  assert.equal(result.files[0]?.name, "latex-0.png");
  assertIsPng(result.files[0]?.attachment);
  assert.ok(result.text.includes("![equation](attachment://latex-0.png)"));
  assert.ok(!result.text.includes("```latex"));
  assert.ok(result.text.startsWith("Before\n"));
  assert.ok(result.text.endsWith("\nAfter"));
});

test("matches fences case-insensitively and tolerates trailing opener content", async () => {
  const result = await renderLatex("```LaTeX ignored trailer\nE=mc^2\n```");

  assert.equal(result.files.length, 1);
  assert.equal(result.text, "![equation](attachment://latex-0.png)");
});

test("leaves empty latex fences untouched", async () => {
  const input = "```latex\n\n```";
  const result = await renderLatex(input);

  assert.equal(result.text, input);
  assert.deepEqual(result.files, []);
});

test("leaves oversized latex fences untouched", async () => {
  const oversized = "x".repeat(2001);
  const input = `\`\`\`latex\n${oversized}\n\`\`\``;
  const result = await renderLatex(input);

  assert.equal(result.text, input);
  assert.deepEqual(result.files, []);
});

test("renders multiple fences with sequential filenames", async () => {
  const result = await renderLatex(
    "First:\n```latex\na+b\n```\nSecond:\n```latex\n\\frac{1}{2}\n```"
  );

  assert.deepEqual(
    result.files.map((f) => f.name),
    ["latex-0.png", "latex-1.png"]
  );
  const first = result.text.indexOf("attachment://latex-0.png");
  const second = result.text.indexOf("attachment://latex-1.png");
  assert.ok(first !== -1 && second !== -1 && first < second);
});

test("renders valid fences while preserving skipped ones in the same text", async () => {
  const result = await renderLatex("```latex\ny^3\n```\n\n```latex\n\n```");

  assert.equal(result.files.length, 1);
  assert.ok(result.text.includes("![equation](attachment://latex-0.png)"));
  assert.ok(result.text.includes("```latex\n\n```"));
});
