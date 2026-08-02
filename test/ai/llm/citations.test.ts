import assert from "node:assert/strict";
import { test } from "vitest";
import {
  extractSources,
  formatSourceRef,
  fromSuperscript,
  toSuperscript,
} from "../../../src/ai/llm/citations.js";

test("formatSourceRef renders a Discord subtext line with a superscript link", () => {
  assert.equal(
    formatSourceRef({
      index: 1,
      url: "https://example.com/a",
      title: "Example",
    }),
    "-# [¹](https://example.com/a) Example"
  );
});

test("multi-digit indices compose superscripts digit by digit", () => {
  assert.equal(
    formatSourceRef({
      index: 12,
      url: "https://example.com/",
      title: "Twelve",
    }),
    "-# [¹²](https://example.com/) Twelve"
  );
  assert.equal(
    formatSourceRef({ index: 305, url: "https://example.com/", title: "Big" }),
    "-# [³⁰⁵](https://example.com/) Big"
  );
});

test("superscript conversion round-trips", () => {
  for (const n of [1, 12, 305]) {
    assert.equal(fromSuperscript(toSuperscript(n)), n);
  }
  // Number("¹²") is NaN, so the mapping has to be walked by hand
  assert.equal(fromSuperscript("¹²"), 12);
  assert.equal(fromSuperscript("not superscript"), null);
  assert.equal(fromSuperscript(""), null);
  assert.equal(fromSuperscript("⁰"), null);
});

test("lifts a trailing citation list out of the reply", () => {
  const { body, sources } = extractSources(
    "The bridge opened in 1932.¹ It carries eight lanes.²\n\n" +
      "¹ [Harbour Bridge history](https://example.com/history)\n" +
      "² [Traffic figures](https://example.com/traffic)"
  );

  assert.equal(body, "The bridge opened in 1932.¹ It carries eight lanes.²");
  assert.deepEqual(sources, [
    {
      index: 1,
      url: "https://example.com/history",
      title: "Harbour Bridge history",
    },
    { index: 2, url: "https://example.com/traffic", title: "Traffic figures" },
  ]);
});

test("consumes an optional Sources heading above the list", () => {
  for (const heading of [
    "Sources:",
    "**Sources**",
    "## Sources",
    "-# sources",
  ]) {
    const { body, sources } = extractSources(
      `Answer text.¹\n\n${heading}\n¹ [A](https://example.com/a)`
    );
    assert.equal(body, "Answer text.¹", `heading: ${heading}`);
    assert.equal(sources.length, 1);
  }
});

test("accepts bare URLs and our own footer shape", () => {
  const bare = extractSources("Body.¹\n\n¹ Some Title — https://example.com/x");
  assert.deepEqual(bare.sources, [
    { index: 1, url: "https://example.com/x", title: "Some Title" },
  ]);

  const linkFirst = extractSources(
    "Body.¹\n\n[¹](https://example.com/y) Title"
  );
  assert.deepEqual(linkFirst.sources, [
    { index: 1, url: "https://example.com/y", title: "Title" },
  ]);

  const urlOnly = extractSources("Body.¹\n\n¹ https://example.com/z");
  assert.deepEqual(urlOnly.sources, [
    { index: 1, url: "https://example.com/z", title: "example.com" },
  ]);
});

test("keeps the model's own indices even when deduplication leaves gaps", () => {
  const { sources } = extractSources(
    "Body.¹³\n\n" +
      "¹ [A](https://example.com/a)\n" +
      "² [Same as A](https://example.com/a)\n" +
      "³ [C](https://example.com/c)"
  );
  assert.deepEqual(
    sources.map((s) => s.index),
    [1, 3]
  );
});

// Stripping the body is a new way to lose text, which is the failure mode this
// whole change exists to avoid. These pin the cases where nothing may be taken.

test("a reply with no citation list is returned untouched", () => {
  const text = "Just an answer.\n\nWith a second paragraph.";
  const { body, sources } = extractSources(text);
  assert.equal(body, text);
  assert.deepEqual(sources, []);
});

test("a trailing numbered list is not a citation list", () => {
  const text = "Steps:\n\n1. First thing\n2. Second thing";
  const { body, sources } = extractSources(text);
  assert.equal(body, text);
  assert.deepEqual(sources, []);
});

test("a superscript-marked line with no URL stays in the body", () => {
  const text = "Here is the answer.\n\n¹ this footnote has no link at all";
  const { body, sources } = extractSources(text);
  assert.equal(body, text);
  assert.deepEqual(sources, []);
});

test("a reply that is only a source list is left whole", () => {
  const text = "¹ [A](https://example.com/a)\n² [B](https://example.com/b)";
  const { body, sources } = extractSources(text);
  assert.equal(body, text);
  assert.deepEqual(sources, []);
});

test("superscripts inside the body survive the scan", () => {
  const text =
    "The first claim¹ and the second.²\n\n" +
    "¹ [A](https://example.com/a)\n" +
    "² [B](https://example.com/b)";
  const { body } = extractSources(text);
  assert.match(body, /first claim¹/);
  assert.match(body, /second\.²/);
  assert.doesNotMatch(body, /example\.com/);
});

test("an unsalvageable URL drops only its own line", () => {
  const { body, sources } = extractSources(
    "Body.¹\n\n¹ [Bad](javascript:alert(1))\n² [Good](https://example.com/ok)"
  );
  // Not a chosen behaviour so much as a consequence of stopping at the first
  // non-source line: the unusable URL ends the scan, so that line stays
  // visible as raw markdown while the good one above it is still lifted. A
  // stray bibliography line is the acceptable side of the trade — the
  // alternative is a scan that keeps going and can eat answer text.
  assert.match(body, /javascript:alert/);
  assert.deepEqual(sources, [
    { index: 2, url: "https://example.com/ok", title: "Good" },
  ]);
});
