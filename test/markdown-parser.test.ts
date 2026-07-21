import assert from "node:assert/strict";
import test from "node:test";
import { AttachmentBuilder, TextDisplayBuilder } from "discord.js";
import {
  markdownToDiscordComponents,
  splitComponentMessagesWithFiles,
} from "../src/utils/markdown-parser.js";

test("splits a single oversized code line into valid Discord components", () => {
  const longLine = "x".repeat(9000);
  const components = markdownToDiscordComponents(
    `\`\`\`text\n${longLine}\n\`\`\``
  );

  assert.ok(components.length > 1);
  for (const component of components) {
    if (component instanceof TextDisplayBuilder) {
      assert.ok(component.toJSON().content.length <= 4000);
    }
  }
  assert.equal(
    components
      .filter((component) => component instanceof TextDisplayBuilder)
      .map((component) => component.toJSON().content)
      .join("")
      .replaceAll("```text", "")
      .replaceAll("```", "")
      .replaceAll("\n", ""),
    longLine
  );
});

test("preserves invalid images alongside valid gallery images", () => {
  const components = markdownToDiscordComponents(
    "![valid](https://example.com/a.png) ![keep me](not-a-media-url)"
  );
  const rendered = components.map((component) => component.toJSON());

  assert.ok(rendered.some((component) => "items" in component));
  assert.ok(
    rendered.some(
      (component) =>
        "content" in component && component.content.includes("keep me")
    )
  );
});

test("splits attachment-backed components at Discord's ten-file limit", () => {
  const markdown = Array.from(
    { length: 12 },
    (_, index) => `![equation](attachment://latex-${index}.png)`
  ).join("\n");
  const files = Array.from(
    { length: 12 },
    (_, index) =>
      new AttachmentBuilder(Buffer.from(String(index)), {
        name: `latex-${index}.png`,
      })
  );

  const messages = splitComponentMessagesWithFiles(
    markdownToDiscordComponents(markdown),
    files
  );

  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((message) => message.files.length),
    [10, 2]
  );
});
