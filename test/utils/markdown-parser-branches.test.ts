import assert from "node:assert/strict";
import {
  AttachmentBuilder,
  MediaGalleryBuilder,
  SeparatorBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { test } from "vitest";
import {
  extractAttachmentFilenames,
  markdownToDiscordComponents,
  splitComponentMessages,
  splitComponentMessagesWithFiles,
} from "../../src/utils/markdown-parser.js";

test("horizontal rules become separators", () => {
  const components = markdownToDiscordComponents("above\n\n---\n\nbelow");

  assert.equal(components.length, 3);
  assert.ok(components[0] instanceof TextDisplayBuilder);
  assert.ok(components[1] instanceof SeparatorBuilder);
  assert.ok(components[2] instanceof TextDisplayBuilder);
});

test("splits oversized plain text on word boundaries", () => {
  const text = Array.from({ length: 1200 }, (_, i) => `word${i}`).join(" ");
  const components = markdownToDiscordComponents(text);

  assert.ok(components.length > 1);
  const chunks = components.map(
    (c) => (c as TextDisplayBuilder).toJSON().content
  );
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4000);
    // word-boundary splitting never cuts a word in half
    assert.ok(!chunk.startsWith(" ") && !chunk.endsWith(" "));
  }
  assert.equal(chunks.join(" "), text);
});

test("hard-cuts oversized text with no usable word boundary", () => {
  const text = "x".repeat(9000);
  const components = markdownToDiscordComponents(text);

  const chunks = components.map(
    (c) => (c as TextDisplayBuilder).toJSON().content
  );
  assert.deepEqual(
    chunks.map((c) => c.length),
    [4000, 4000, 1000]
  );
  assert.equal(chunks.join(""), text);
});

test("keeps a smaller inner fence inside an outer fence as one block", () => {
  const markdown = "````\n```\ninner\n```\n````";
  const components = markdownToDiscordComponents(markdown);

  assert.equal(components.length, 1);
  assert.equal(
    (components[0] as TextDisplayBuilder).toJSON().content,
    markdown
  );
});

test("a closing line with more backticks than the opener closes the fence", () => {
  const components = markdownToDiscordComponents("```js\ncode\n````\nafter");

  assert.equal(components.length, 2);
  assert.equal(
    (components[0] as TextDisplayBuilder).toJSON().content,
    "```js\ncode\n````"
  );
  assert.equal((components[1] as TextDisplayBuilder).toJSON().content, "after");
});

test("a backtick line with trailing content inside a fence is body, not a closer", () => {
  const markdown = "```\n```not-a-closer\n```";
  const components = markdownToDiscordComponents(markdown);

  assert.equal(components.length, 1);
  assert.equal(
    (components[0] as TextDisplayBuilder).toJSON().content,
    markdown
  );
});

test("a fence opening directly under text flushes that text first", () => {
  // no blank line between the paragraph and the fence
  const components = markdownToDiscordComponents("intro\n```js\ncode\n```");

  assert.equal(components.length, 2);
  assert.equal((components[0] as TextDisplayBuilder).toJSON().content, "intro");
  assert.equal(
    (components[1] as TextDisplayBuilder).toJSON().content,
    "```js\ncode\n```"
  );
});

test("runs of blank lines do not emit empty paragraphs", () => {
  const components = markdownToDiscordComponents("\n\n\nalpha\n\n\n\nbeta\n\n");

  assert.deepEqual(
    components.map((c) => (c as TextDisplayBuilder).toJSON().content),
    ["alpha", "beta"]
  );
});

test("an oversized fence of short lines splits on line boundaries", () => {
  const lines = Array.from({ length: 600 }, (_, i) => `line ${i};`);
  const components = markdownToDiscordComponents(
    `\`\`\`ts\n${lines.join("\n")}\n\`\`\``
  );

  assert.ok(components.length > 1);
  const chunks = components.map(
    (c) => (c as TextDisplayBuilder).toJSON().content
  );
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 4000);
    assert.ok(chunk.startsWith("```ts\n"));
    assert.ok(chunk.endsWith("\n```"));
  }
  // every source line survives exactly once, and none is cut in half
  const body = chunks
    .flatMap((c) => c.split("\n").slice(1, -1))
    .filter((l) => l !== "");
  assert.deepEqual(body, lines);
});

test("splitComponentMessages returns nothing for an empty component list", () => {
  assert.deepEqual(splitComponentMessages([]), []);
});

test("an unclosed fence is emitted as-is", () => {
  const components = markdownToDiscordComponents("text\n\n```js\nunclosed");

  assert.equal(components.length, 2);
  assert.equal(
    (components[1] as TextDisplayBuilder).toJSON().content,
    "```js\nunclosed"
  );
});

test("an unclosed oversized fence splits without inventing a final closer", () => {
  const body = "y".repeat(9000);
  const components = markdownToDiscordComponents(`\`\`\`\n${body}`);

  assert.ok(components.length > 1);
  const chunks = components.map(
    (c) => (c as TextDisplayBuilder).toJSON().content
  );
  for (const chunk of chunks) assert.ok(chunk.length <= 4000);
  // intermediate chunks are closed, the final one stays open like the input
  assert.ok(chunks[0]?.endsWith("```"));
  assert.ok(!chunks[chunks.length - 1]?.endsWith("```"));
  assert.equal(
    chunks.join("").replaceAll("```", "").replaceAll("\n", ""),
    body
  );
});

test("splitComponentMessages caps a message at 40 components", () => {
  const components = Array.from({ length: 45 }, () =>
    new TextDisplayBuilder().setContent("x")
  );
  const messages = splitComponentMessages(components);

  assert.deepEqual(
    messages.map((m) => m.length),
    [40, 5]
  );
});

test("splitComponentMessages caps total text characters per message", () => {
  const components = [
    new TextDisplayBuilder().setContent("a".repeat(3000)),
    new TextDisplayBuilder().setContent("b".repeat(3000)),
  ];
  const messages = splitComponentMessages(components);

  assert.equal(messages.length, 2);
});

test("more than ten images in a paragraph split into multiple galleries", () => {
  const markdown = Array.from(
    { length: 12 },
    (_, i) => `![img${i}](https://example.com/${i}.png)`
  ).join(" ");
  const components = markdownToDiscordComponents(markdown);

  const galleries = components.filter((c) => c instanceof MediaGalleryBuilder);
  assert.equal(galleries.length, 2);
  assert.deepEqual(
    galleries.map((g) => g.toJSON().items.length),
    [10, 2]
  );
});

test("empty alt text yields no gallery description; long alt is truncated", () => {
  const longAlt = "a".repeat(2000);
  const components = markdownToDiscordComponents(
    `![](https://example.com/a.png) ![${longAlt}](https://example.com/b.png)`
  );

  const gallery = components.find((c) => c instanceof MediaGalleryBuilder);
  assert.ok(gallery);
  const items = gallery.toJSON().items;
  assert.equal(items[0]?.description, undefined);
  assert.equal(items[1]?.description?.length, 1024);
});

test("invalid image without alt falls back to the bare url", () => {
  const components = markdownToDiscordComponents("![](not-a-url)");

  assert.equal(components.length, 1);
  assert.equal(
    (components[0] as TextDisplayBuilder).toJSON().content,
    "not-a-url"
  );
});

test("text before, between, and after images keeps its order", () => {
  const components = markdownToDiscordComponents(
    "intro ![a](https://example.com/a.png) middle ![b](https://example.com/b.png) outro"
  );

  const shapes = components.map((c) =>
    c instanceof MediaGalleryBuilder ? "gallery" : "text"
  );
  assert.deepEqual(shapes, ["text", "gallery", "text", "gallery", "text"]);
  assert.equal((components[0] as TextDisplayBuilder).toJSON().content, "intro");
  assert.equal((components[4] as TextDisplayBuilder).toJSON().content, "outro");
});

test("an invalid image between valid ones splits the gallery run", () => {
  const components = markdownToDiscordComponents(
    "![a](https://example.com/a.png)![bad](nope)![b](https://example.com/b.png)"
  );

  const shapes = components.map((c) =>
    c instanceof MediaGalleryBuilder ? "gallery" : "text"
  );
  assert.deepEqual(shapes, ["gallery", "text", "gallery"]);
  assert.equal(
    (components[1] as TextDisplayBuilder).toJSON().content,
    "[bad](nope)"
  );
});

test("extractAttachmentFilenames finds names in text and gallery items", () => {
  const components = markdownToDiscordComponents(
    "see attachment://note.txt\n\n![e](attachment://plot.png)"
  );
  components.push(new SeparatorBuilder());

  const names = extractAttachmentFilenames(components);
  assert.deepEqual([...names].sort(), ["note.txt", "plot.png"]);
});

test("splitComponentMessagesWithFiles drops unreferenced files", () => {
  const components = markdownToDiscordComponents("![e](attachment://used.png)");
  const files = [
    new AttachmentBuilder(Buffer.from("a"), { name: "used.png" }),
    new AttachmentBuilder(Buffer.from("b"), { name: "unused.png" }),
  ];

  const messages = splitComponentMessagesWithFiles(components, files);

  assert.equal(messages.length, 1);
  assert.deepEqual(
    messages[0]?.files.map((f) => f.name),
    ["used.png"]
  );
});
