import assert from "node:assert/strict";
import { afterEach, beforeAll, test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";
import {
  installFakeClient,
  lastReplyText,
  loaderContext,
  makeInteraction,
  stubRegistry,
} from "./harness.js";

bootstrapTestEnv();
installFakeClient();

const { runMigrations } = await import("../../../src/db/migrate.js");
const { db, storylines } = await import("../../../src/db/index.js");
const logbook = await import("../../../src/ai/logbook/store.js");
const { env } = await import("../../../src/config/env.js");
const { LogbookCommand } = await import(
  "../../../src/discord/commands/logbook.js"
);

const command = new LogbookCommand(loaderContext("logbook"), {});

beforeAll(async () => {
  await runMigrations();
});

afterEach(() => {
  env.GUILD_ID = undefined;
});

async function seedStoryline(
  scope: { guildId: string | null; channelId: string },
  overrides: Partial<Parameters<typeof logbook.createStoryline>[0]> = {}
) {
  return logbook.createStoryline({
    ...scope,
    title: "Ship the release",
    goal: "Publish version 0.2",
    currentState: "Preparing the release candidate",
    createdByUserId: "user-1",
    ...overrides,
  });
}

// registration

test("registers list and show globally", () => {
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(chatInput.length, 1);
  const json = chatInput[0]?.builder.toJSON();
  assert.equal(json?.name, "logbook");
  assert.deepEqual(
    json?.options?.map((o) => o.name),
    ["list", "show"]
  );
  assert.equal(json?.integration_types?.length, 2);
  assert.equal(json?.contexts?.length, 3);
});

test("adds a guild-scoped registration when GUILD_ID is set", () => {
  env.GUILD_ID = "guild-42";
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(chatInput.length, 2);
  assert.deepEqual(chatInput[0]?.options, { guildIds: ["guild-42"] });
});

// list

test("list explains how to get started when the Logbook is empty", async () => {
  const interaction = makeInteraction({
    guildId: "guild-empty",
    options: { subcommand: "list" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(interaction.deferReply.mock.calls.length, 1);
  assert.equal(
    lastReplyText(interaction),
    "The Logbook is empty. Ask me to start tracking an ongoing goal or project."
  );
});

test("list shows open storylines with owners and a truncated current state", async () => {
  const storyline = await seedStoryline(
    { guildId: "guild-list", channelId: "chan-list" },
    {
      title: "Migrate the database",
      currentState: "s".repeat(200),
      ownerUserIds: ["owner-1", "owner-2"],
    }
  );
  const interaction = makeInteraction({
    guildId: "guild-list",
    channelId: "chan-list",
    options: { subcommand: "list" },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.match(reply, /^## Logbook\n\n/);
  assert.match(
    reply,
    new RegExp(
      `\\*\\*#${storyline.id} Migrate the database\\*\\* · open · <@owner-1>, <@owner-2>`
    )
  );
  assert.match(reply, new RegExp(`> ${"s".repeat(179)}…`));
  assert.match(reply, /-# Use `\/logbook show <id>` for the full history\.$/);
});

test("list hides closed storylines unless include-closed is set", async () => {
  const scope = { guildId: "guild-closed", channelId: "chan-closed" };
  const open = await seedStoryline(scope, { title: "Still going" });
  const done = await seedStoryline(scope, { title: "All wrapped up" });
  await logbook.recordStorylineEvent({
    ...scope,
    storylineId: done.id,
    kind: "milestone",
    summary: "shipped",
    storylineStatus: "completed",
  });

  const hidden = makeInteraction({ ...scope, options: { subcommand: "list" } });
  await command.chatInputRun(hidden as never);
  assert.match(lastReplyText(hidden), new RegExp(`#${open.id} Still going`));
  assert.ok(!lastReplyText(hidden).includes("All wrapped up"));

  const shown = makeInteraction({
    ...scope,
    options: { subcommand: "list", booleans: { "include-closed": true } },
  });
  await command.chatInputRun(shown as never);
  assert.match(
    lastReplyText(shown),
    new RegExp(`#${done.id} All wrapped up\\*\\* · completed`)
  );
});

test("list keeps another scope's storylines out", async () => {
  await seedStoryline(
    { guildId: null, channelId: "dm-other" },
    { title: "Someone else's DM plan" }
  );
  const interaction = makeInteraction({
    guildId: null,
    channelId: "dm-mine",
    options: { subcommand: "list" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    "The Logbook is empty. Ask me to start tracking an ongoing goal or project."
  );
});

test("list caps the reply at Discord's message limit", async () => {
  const scope = { guildId: "guild-big", channelId: "chan-big" };
  for (let i = 0; i < 20; i++) {
    await seedStoryline(scope, {
      title: `Storyline ${i} ${"t".repeat(60)}`,
      currentState: "c".repeat(180),
    });
  }
  const interaction = makeInteraction({
    ...scope,
    options: { subcommand: "list" },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.equal(reply.length, 2000);
  assert.ok(reply.endsWith("…"));
});

// show

test("show reports when the storyline is not in this Logbook", async () => {
  const interaction = makeInteraction({
    guildId: "guild-missing",
    options: { subcommand: "show", integers: { id: 9999 } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    "That storyline isn't in this Logbook."
  );
});

test("show renders the header, owners, tags and an empty history", async () => {
  const scope = { guildId: "guild-show", channelId: "chan-show" };
  // inserted straight into the table: createStoryline always logs a "created"
  // milestone, which would hide the empty-history branch
  const [storyline] = await db
    .insert(storylines)
    .values({
      ...scope,
      title: "Rewrite the parser",
      goal: "Handle nested tables",
      currentState: "Sketching the grammar",
      ownerUserIds: ["owner-9"],
      tags: ["parser", "tech-debt"],
    })
    .returning({ id: storylines.id });
  assert.ok(storyline);
  const interaction = makeInteraction({
    ...scope,
    options: { subcommand: "show", integers: { id: storyline.id } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    [
      `## #${storyline.id} Rewrite the parser`,
      "**Status:** open",
      "**Owners:** <@owner-9>",
      "**Tags:** `parser` `tech-debt`",
      "",
      "**Goal**",
      "Handle nested tables",
      "",
      "**Current state**",
      "Sketching the grammar",
      "",
      "### Recent history",
      "No events recorded yet.",
    ].join("\n")
  );
});

test("show marks open loops, resolutions, owners and due dates", async () => {
  const scope = { guildId: "guild-events", channelId: "chan-events" };
  const storyline = await seedStoryline(scope, { title: "Launch checklist" });
  const dueAt = new Date("2030-01-01T00:00:00.000Z");

  const decision = await logbook.recordStorylineEvent({
    ...scope,
    storylineId: storyline.id,
    kind: "decision",
    summary: "Picked Postgres",
  });
  const commitment = await logbook.recordStorylineEvent({
    ...scope,
    storylineId: storyline.id,
    kind: "commitment",
    summary: "Write the migration",
    ownerUserId: "owner-3",
    dueAt,
  });
  const question = await logbook.recordStorylineEvent({
    ...scope,
    storylineId: storyline.id,
    kind: "open_question",
    summary: "Which region do we deploy to?",
  });
  assert.ok(decision && commitment && question);
  await logbook.resolveStorylineEvent({
    ...scope,
    storylineId: storyline.id,
    eventId: question.event.id,
  });

  const interaction = makeInteraction({
    ...scope,
    options: { subcommand: "show", integers: { id: storyline.id } },
  });
  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  // no owners or tags were set, so those lines are absent
  assert.ok(!reply.includes("**Owners:**"));
  assert.ok(!reply.includes("**Tags:**"));
  assert.match(
    reply,
    new RegExp(`• \\*\\*#${decision.event.id} decision\\*\\*`)
  );
  assert.match(
    reply,
    new RegExp(
      `○ \\*\\*#${commitment.event.id} commitment\\*\\* · <@owner-3> · due <t:${Math.floor(dueAt.getTime() / 1000)}:R>`
    )
  );
  assert.match(
    reply,
    new RegExp(`✓ \\*\\*#${question.event.id} open question\\*\\*`)
  );
});

test("show truncates long event summaries and the whole reply", async () => {
  const scope = { guildId: "guild-trunc", channelId: "chan-trunc" };
  const storyline = await seedStoryline(scope, { title: "Long one" });
  for (let i = 0; i < 12; i++) {
    await logbook.recordStorylineEvent({
      ...scope,
      storylineId: storyline.id,
      kind: "note",
      summary: `${"e".repeat(300)}-${i}`,
    });
  }
  const interaction = makeInteraction({
    ...scope,
    options: { subcommand: "show", integers: { id: storyline.id } },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.equal(reply.length, 2000);
  assert.ok(reply.endsWith("…"));
  // each event summary was clipped to 240 chars before the reply-wide clip
  assert.ok(!reply.includes("e".repeat(241)));
});
