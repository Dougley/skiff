import assert from "node:assert/strict";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { getPersona, hasPersona, setPersona, setPersonaOverride } = await import(
  "../../../src/ai/persona/state.js"
);
const { personaSchema } = await import("../../../src/ai/persona/schema.js");

const persona = personaSchema.parse({
  name: "Marnie",
  description: "Ship's quartermaster.",
  voice: ["short sentences"],
  examples: [{ user: "hi", assistant: "hey" }],
});

// module state is global, so this runs first: the empty state only exists once
test("nothing is loaded before a persona is set", () => {
  assert.equal(hasPersona(), false);
  assert.equal(getPersona(), null);
  assert.equal(getPersona("any-channel"), null);
});

test("a set persona is returned for every channel", () => {
  setPersona(persona);
  assert.equal(hasPersona(), true);
  assert.equal(getPersona(), persona);
  assert.equal(getPersona("channel-1"), persona);
  assert.equal(getPersona(null), persona);
});

test("an override applies to its channel and nowhere else", () => {
  setPersona(persona);
  setPersonaOverride("channel-1", { voice: ["all caps, no mercy"] });

  assert.deepEqual(getPersona("channel-1")?.voice, ["all caps, no mercy"]);
  assert.deepEqual(getPersona("channel-2")?.voice, persona.voice);
  assert.deepEqual(getPersona()?.voice, persona.voice);
  // unoverridden fields still come from the base persona
  assert.equal(getPersona("channel-1")?.name, "Marnie");
  // the base object itself is never mutated
  assert.deepEqual(persona.voice, ["short sentences"]);
});

test("overrides on the same channel merge instead of replacing", () => {
  setPersona(persona);
  setPersonaOverride("channel-merge", { voice: ["whispered"] });
  setPersonaOverride("channel-merge", { nickname: "Mar" });

  const merged = getPersona("channel-merge");
  assert.deepEqual(merged?.voice, ["whispered"]);
  assert.equal(merged?.nickname, "Mar");
});

test("loading a persona wipes every channel override", () => {
  setPersona(persona);
  setPersonaOverride("channel-1", { voice: ["temporary"] });
  assert.deepEqual(getPersona("channel-1")?.voice, ["temporary"]);

  const reloaded = personaSchema.parse({ ...persona, name: "Marnie II" });
  setPersona(reloaded);

  assert.equal(getPersona("channel-1")?.name, "Marnie II");
  assert.deepEqual(getPersona("channel-1")?.voice, persona.voice);
});
