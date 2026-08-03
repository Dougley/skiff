import assert from "node:assert/strict";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { buildPersonaPrompt } = await import(
  "../../../src/ai/persona/prompt.js"
);
const { personaSchema } = await import("../../../src/ai/persona/schema.js");

const base = personaSchema.parse({
  name: "Marnie",
  description: "Ship's quartermaster. Practical, dry-witted.",
  voice: ["short sentences", "dry humour"],
  examples: [
    { user: "Do we have rope?", assistant: "Forty metres." },
    { user: "Thanks", assistant: "Mm." },
  ],
});

test("the prompt opens with the persona's identity and description", () => {
  const prompt = buildPersonaPrompt(base);
  assert.ok(prompt.startsWith("You are Marnie.\n"));
  assert.match(prompt, /Ship's quartermaster\. Practical, dry-witted\./);
});

test("a distinct nickname is shown alongside the name", () => {
  const prompt = buildPersonaPrompt({ ...base, nickname: "Mar" });
  assert.ok(prompt.startsWith("You are Marnie (Mar)."));
});

test("a nickname identical to the name is not repeated", () => {
  const prompt = buildPersonaPrompt({ ...base, nickname: "Marnie" });
  assert.ok(prompt.startsWith("You are Marnie."));
  assert.ok(!prompt.includes("Marnie (Marnie)"));
});

test("voice lines are always rendered as bullets", () => {
  const prompt = buildPersonaPrompt(base);
  assert.match(prompt, /## Voice\n- short sentences\n- dry humour/);
});

test("optional sections are omitted when absent or empty", () => {
  const prompt = buildPersonaPrompt(base);
  assert.ok(!prompt.includes("## How you work"));
  assert.ok(!prompt.includes("## Never say"));

  const empty = buildPersonaPrompt({ ...base, principles: [], avoid: [] });
  assert.ok(!empty.includes("## How you work"));
  assert.ok(!empty.includes("## Never say"));
});

test("principles and avoided phrasings each get their own section", () => {
  const prompt = buildPersonaPrompt({
    ...base,
    principles: ["measure twice", "log everything"],
    avoid: ["Great question!", "Absolutely!"],
  });
  assert.match(prompt, /## How you work\n- measure twice\n- log everything/);
  // avoided phrasings are quoted so the model reads them as literal strings
  assert.match(
    prompt,
    /## Never say\nThese phrasings aren't you, don't use them:\n- "Great question!"\n- "Absolutely!"/
  );
});

test("examples are rendered as plain user/you exchanges in order", () => {
  const prompt = buildPersonaPrompt(base);
  assert.match(prompt, /## Examples of your voice/);
  assert.match(
    prompt,
    /User: Do we have rope\?\nYou: Forty metres\.\n\nUser: Thanks\nYou: Mm\./
  );
  // examples come last, after every other section
  assert.ok(
    prompt.indexOf("## Examples of your voice") > prompt.indexOf("## Voice")
  );
});

test("section order stays stable across a fully populated persona", () => {
  const prompt = buildPersonaPrompt({
    ...base,
    principles: ["measure twice"],
    avoid: ["synergy"],
  });
  const order = [
    "You are Marnie.",
    "## Voice",
    "## How you work",
    "## Never say",
    "## Examples of your voice",
  ].map((marker) => prompt.indexOf(marker));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b)
  );
  assert.ok(order.every((index) => index >= 0));
});
