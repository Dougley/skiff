import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();
process.env.LLM_DEFAULT_MODEL = "gpt-4o-mini";

const { env } = await import("../../../src/config/env.js");
const { buildTurnContext, getSystemPrompt } = await import(
  "../../../src/ai/llm/system-prompt.js"
);
const { setPersona, setPersonaOverride } = await import(
  "../../../src/ai/persona/state.js"
);
const { initSkills } = await import("../../../src/ai/skills/index.js");
const { loadAddendaCache } = await import(
  "../../../src/autonomous/sleep/addenda.js"
);
const { runMigrations } = await import("../../../src/db/migrate.js");
const { db, personaAddenda } = await import("../../../src/db/index.js");

await runMigrations();

const persona = {
  name: "Skiff",
  nickname: "Skiffy",
  description: "A small boat of a bot.",
  voice: ["short sentences"],
  principles: ["measure twice"],
  avoid: ["as an AI"],
  examples: [{ user: "hi", assistant: "hey" }],
};

test("without a persona the stable span carries the fallback notice", () => {
  const { stable } = getSystemPrompt();
  assert.match(stable, /No persona data available/);
  // no addenda and no skills loaded yet
  assert.doesNotMatch(stable, /## Durable Persona Notes/);
  assert.doesNotMatch(stable, /## Skills/);
});

test("the variable span defaults to LLM_DEFAULT_MODEL with no chat context", () => {
  const { variable } = getSystemPrompt();
  assert.match(variable, new RegExp(`Model: ${env.LLM_DEFAULT_MODEL}`));
  assert.doesNotMatch(variable, /chat_type/);
  assert.doesNotMatch(variable, /Earlier Conversation Summary/);
});

test("a loaded persona replaces the fallback in the stable span", () => {
  setPersona(persona);
  const { stable } = getSystemPrompt();
  assert.match(stable, /You are Skiff \(Skiffy\)\./);
  assert.doesNotMatch(stable, /No persona data available/);
});

test("a channel persona override changes only that channel's stable span", () => {
  setPersona(persona);
  setPersonaOverride("chan-styled", { name: "Dinghy" });
  const styled = getSystemPrompt({ channelId: "chan-styled" });
  const plain = getSystemPrompt({ channelId: "chan-normal" });
  assert.match(styled.stable, /You are Dinghy/);
  assert.match(plain.stable, /You are Skiff/);
});

test("active addenda land in the stable span, scoped by guild", async () => {
  await db.insert(personaAddenda).values([
    { text: "global note", active: true },
    { text: "guild note", guildId: "guild-1", active: true },
    { text: "dm note", channelId: "dm-chan", active: true },
    { text: "inactive note", active: false },
  ]);
  await loadAddendaCache();

  const guild = getSystemPrompt({ guildId: "guild-1" }).stable;
  assert.match(guild, /## Durable Persona Notes/);
  assert.match(guild, /- global note/);
  assert.match(guild, /- guild note/);
  assert.doesNotMatch(guild, /dm note/);
  assert.doesNotMatch(guild, /inactive note/);

  // DM scope: global + channel notes, never guild notes
  const dm = getSystemPrompt({ guildId: null, channelId: "dm-chan" }).stable;
  assert.match(dm, /- dm note/);
  assert.doesNotMatch(dm, /guild note/);
});

test("discovered skills are cataloged in the stable span", async () => {
  const skillsDir = path.join(tmpdir(), `skiff-test-skills-${process.pid}`);
  await mkdir(path.join(skillsDir, "greeter"), { recursive: true });
  await writeFile(
    path.join(skillsDir, "greeter", "SKILL.md"),
    "---\nname: greeter\ndescription: Greets people warmly\n---\nSay hello.\n"
  );
  await initSkills(skillsDir);

  const { stable } = getSystemPrompt();
  assert.match(stable, /## Skills/);
  assert.match(stable, /- \*\*greeter\*\*: Greets people warmly/);

  await initSkills(path.join(skillsDir, "does-not-exist"));
  assert.doesNotMatch(getSystemPrompt().stable, /## Skills/);
});

test("a guild channel context renders channel and guild names", () => {
  const { variable } = getSystemPrompt({
    messageContext: {
      displayName: "Remco",
      username: "remco",
      channelName: "#general",
      guildName: "Test Guild",
      isDM: false,
    },
    model: "gpt-4o",
  });
  assert.match(variable, /"chat_type":"guild_channel"/);
  assert.match(variable, /"channel":"#general"/);
  assert.match(variable, /"guild":"Test Guild"/);
  assert.match(variable, /Model: gpt-4o/);
});

test("a guild channel with no guild name omits the guild key", () => {
  const { variable } = getSystemPrompt({
    messageContext: {
      displayName: "Remco",
      username: "remco",
      channelName: "#general",
      guildName: null,
      isDM: false,
    },
  });
  assert.doesNotMatch(variable, /"guild":/);
});

test("a DM context never leaks a guild name", () => {
  const { variable } = getSystemPrompt({
    messageContext: {
      displayName: "Remco",
      username: "remco",
      channelName: "DM",
      guildName: "Should Not Appear",
      isDM: true,
    },
  });
  assert.match(variable, /"chat_type":"direct_message"/);
  assert.doesNotMatch(variable, /Should Not Appear/);
});

test("a rolling summary is injected into the variable span", () => {
  const { variable } = getSystemPrompt({
    conversationSummary: "We were debugging the retry policy.",
  });
  assert.match(variable, /## Earlier Conversation Summary/);
  assert.match(variable, /We were debugging the retry policy\./);
});

test("turn context with no extras is just the clock", () => {
  const block = buildTurnContext({ now: new Date("2026-08-03T10:00:00.000Z") });
  assert.match(block ?? "", /Current time: 2026-08-03T10:00:00\.000Z/);
  assert.doesNotMatch(block ?? "", /Logbook Storylines/);
  assert.doesNotMatch(block ?? "", /User Facts/);
});

test("turn context defaults its clock to now", () => {
  const before = Date.now();
  const block = buildTurnContext({});
  const match = /Current time: (.+)$/m.exec(block ?? "");
  assert.ok(match?.[1]);
  const stamp = Date.parse(match[1]);
  assert.ok(stamp >= before - 1000 && stamp <= Date.now() + 1000);
});

test("turn context renders storylines and facts as bullets", () => {
  const block = buildTurnContext({
    logbookContext: ["#1 Ship it [active] — Goal: done"],
    userFacts: ["Lives in NL"],
  });
  assert.match(block ?? "", /## Relevant Logbook Storylines/);
  assert.match(block ?? "", /- #1 Ship it \[active\] — Goal: done/);
  assert.match(block ?? "", /## Memory: User Facts/);
  assert.match(block ?? "", /- Lives in NL/);
});
