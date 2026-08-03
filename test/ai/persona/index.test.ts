import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const {
  isPersona,
  loadPersonaFile,
  parsePersonaJson,
  parsePersonaObject,
  PersonaLoadError,
} = await import("../../../src/ai/persona/index.js");

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

/** Runs `fn` and returns the error it threw — node's assert.throws returns nothing. */
function captureThrow(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  throw new assert.AssertionError({ message: "expected the call to throw" });
}

const valid = {
  name: "Marnie",
  description: "Ship's quartermaster.",
  voice: ["short sentences"],
  examples: [{ user: "hi", assistant: "hey" }],
};

test("a well-formed persona object parses and keeps its optional fields", () => {
  const persona = parsePersonaObject({
    ...valid,
    nickname: "Mar",
    principles: ["measure twice"],
    avoid: ["synergy"],
    meta: { version: "1.0", author: "test" },
  });
  assert.equal(persona.name, "Marnie");
  assert.equal(persona.nickname, "Mar");
  assert.deepEqual(persona.principles, ["measure twice"]);
  assert.deepEqual(persona.meta, { version: "1.0", author: "test" });
});

test("isPersona is a predicate, not a thrower", () => {
  assert.equal(isPersona(valid), true);
  assert.equal(isPersona({ ...valid, voice: [] }), false);
  assert.equal(isPersona(null), false);
  assert.equal(isPersona("a persona, honestly"), false);
});

test("an invalid persona object reports the offending fields", () => {
  const error = captureThrow(() =>
    parsePersonaObject({ ...valid, voice: [], examples: [] }, "unit-test")
  );

  assert.ok(error instanceof PersonaLoadError);
  assert.equal(error.name, "PersonaLoadError");
  assert.match(error.message, /unit-test/);
  // the prettified zod error names the fields that failed
  assert.match(error.message, /voice/);
  assert.match(error.message, /examples/);
  assert.ok(error.cause);
});

test("the default source label appears when none is given", () => {
  const error = captureThrow(() => parsePersonaObject({}));
  assert.ok(error instanceof PersonaLoadError);
  assert.match(error.message, /for object/);
});

test("persona JSON round-trips, and malformed JSON is reported as such", () => {
  assert.equal(parsePersonaJson(JSON.stringify(valid)).name, "Marnie");

  const error = captureThrow(() => parsePersonaJson("{ not json", "inline"));
  assert.ok(error instanceof PersonaLoadError);
  assert.match(error.message, /Invalid JSON in persona inline/);
  assert.ok(error.cause instanceof SyntaxError);
});

test("a persona file loads from disk", async () => {
  const persona = await loadPersonaFile(fixture("persona-valid.json"));
  assert.equal(persona.name, "Marnie");
  assert.equal(persona.nickname, "Mar");
  assert.equal(persona.examples.length, 1);
  assert.deepEqual(persona.avoid, ["synergy", "circle back"]);
});

test("the repo's own persona file is valid", async () => {
  const persona = await loadPersonaFile(
    fileURLToPath(new URL("../../../agent.persona.json", import.meta.url))
  );
  assert.ok(persona.name.length > 0);
  assert.ok(persona.voice.length > 0);
  assert.ok(persona.examples.length > 0);
});

test("a file that fails validation names the file it came from", async () => {
  const filePath = fixture("persona-invalid.json");
  await assert.rejects(loadPersonaFile(filePath), (error: Error) => {
    assert.ok(error instanceof PersonaLoadError);
    assert.match(error.message, /Persona validation failed/);
    assert.ok(error.message.includes(filePath));
    return true;
  });
});

test("an unreadable file fails with a read error rather than a parse error", async () => {
  await assert.rejects(
    loadPersonaFile(fixture("persona-does-not-exist.json")),
    (error: Error) => {
      assert.ok(error instanceof PersonaLoadError);
      assert.match(error.message, /Failed to read persona file at/);
      assert.ok(error.cause);
      return true;
    }
  );
});
