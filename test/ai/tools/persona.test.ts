import assert from "node:assert/strict";
import type { Client } from "discord.js";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { createPersonaTools } = await import("../../../src/ai/tools/persona.js");
const { setPersona, getPersona } = await import(
  "../../../src/ai/persona/state.js"
);

const toolOpts = { toolCallId: "test-call", messages: [] } as never;

const ctx = {
  client: {} as Client,
  guildId: "persona-guild",
  channelId: "persona-channel",
  userId: "user-1",
};

const basePersona = {
  name: "Skiff",
  description: "A small vessel with a big personality.",
  voice: ["short sentences", "dry humor"],
  examples: [{ user: "hi", assistant: "hey" }],
};

test("both tools error before a persona is loaded", async () => {
  // module state starts empty — exercise the not-loaded guard first
  const tools = createPersonaTools(ctx);
  assert.deepEqual(
    await tools.get_persona_part.execute?.({ partId: "voice" }, toolOpts),
    { error: "Persona is not loaded." }
  );
  assert.deepEqual(
    await tools.set_persona_part.execute?.(
      { partId: "voice", content: '["x"]' },
      toolOpts
    ),
    { error: "Persona is not loaded." }
  );
});

test("get_persona_part returns a set part and errors on an unset one", async () => {
  setPersona(basePersona);
  const tools = createPersonaTools(ctx);

  const voice = await tools.get_persona_part.execute?.(
    { partId: "voice" },
    toolOpts
  );
  assert.deepEqual(voice, { part: ["short sentences", "dry humor"] });

  // nickname was never set on the base persona
  const nickname = await tools.get_persona_part.execute?.(
    { partId: "nickname" },
    toolOpts
  );
  assert.deepEqual(nickname, { error: "No persona part set for: nickname" });
});

test("set_persona_part rejects invalid JSON", async () => {
  setPersona(basePersona);
  const tools = createPersonaTools(ctx);
  const result = await tools.set_persona_part.execute?.(
    { partId: "voice", content: "not json {" },
    toolOpts
  );
  assert.deepEqual(result, { error: "content must be valid JSON." });
});

test("set_persona_part rejects JSON that does not match the schema", async () => {
  setPersona(basePersona);
  const tools = createPersonaTools(ctx);
  // voice must be a non-empty array of non-empty strings
  const result = await tools.set_persona_part.execute?.(
    { partId: "voice", content: "[1, 2, 3]" },
    toolOpts
  );
  assert.deepEqual(result, {
    error: "content does not match the persona schema.",
  });
});

test("set_persona_part applies a channel-scoped override", async () => {
  setPersona(basePersona);
  const tools = createPersonaTools(ctx);

  const result = (await tools.set_persona_part.execute?.(
    { partId: "voice", content: '["booming pirate speech"]' },
    toolOpts
  )) as { success: boolean; updatedPart: string[] };
  assert.equal(result.success, true);
  assert.deepEqual(result.updatedPart, ["booming pirate speech"]);

  // visible in this channel, invisible elsewhere
  assert.deepEqual(getPersona(ctx.channelId)?.voice, ["booming pirate speech"]);
  assert.deepEqual(getPersona("some-other-channel")?.voice, [
    "short sentences",
    "dry humor",
  ]);

  // the tool reads through the override too
  const readBack = await tools.get_persona_part.execute?.(
    { partId: "voice" },
    toolOpts
  );
  assert.deepEqual(readBack, { part: ["booming pirate speech"] });
});

test("set_persona_part can set principles as well", async () => {
  setPersona(basePersona);
  const tools = createPersonaTools(ctx);
  const result = (await tools.set_persona_part.execute?.(
    { partId: "principles", content: '["measure twice"]' },
    toolOpts
  )) as { success: boolean };
  assert.equal(result.success, true);
  assert.deepEqual(getPersona(ctx.channelId)?.principles, ["measure twice"]);
});
