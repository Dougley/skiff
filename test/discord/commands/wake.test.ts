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
const { db, storylineEventLinks } = await import("../../../src/db/index.js");
const { getOrCreateConversation, insertMessage } = await import(
  "../../../src/db/queries.js"
);
const logbook = await import("../../../src/ai/logbook/store.js");
const { env } = await import("../../../src/config/env.js");
const { WakeCommand } = await import("../../../src/discord/commands/wake.js");

const command = new WakeCommand(loaderContext("wake"), {});

beforeAll(async () => {
  await runMigrations();
});

afterEach(() => {
  env.GUILD_ID = undefined;
});

/** Creates a storyline plus one event per summary, returning their event ids. */
async function seedEvents(
  scope: { guildId: string | null; channelId: string },
  summaries: { summary: string; sourceMessageId?: number }[]
): Promise<number[]> {
  const storyline = await logbook.createStoryline({
    ...scope,
    title: "Ship the release",
    goal: "Publish version 0.2",
    currentState: "Preparing",
  });
  const ids: number[] = [];
  for (const entry of summaries) {
    const recorded = await logbook.recordStorylineEvent({
      ...scope,
      storylineId: storyline.id,
      kind: "decision",
      summary: entry.summary,
      sourceMessageId: entry.sourceMessageId ?? null,
    });
    assert.ok(recorded);
    ids.push(recorded.event.id);
  }
  return ids;
}

/** Inserts a real message row so a Logbook event can cite it as evidence. */
async function seedMessage(
  scope: { guildId: string | null; channelId: string },
  content: string
): Promise<number> {
  const conversation = await getOrCreateConversation(scope);
  const message = await insertMessage({
    conversationId: conversation.id,
    role: "user",
    content,
  });
  return message.id;
}

// registration

test("registers the event and depth options globally", () => {
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(chatInput.length, 1);
  const json = chatInput[0]?.builder.toJSON();
  assert.equal(json?.name, "wake");
  assert.deepEqual(
    json?.options?.map((o) => [o.name, o.required ?? false]),
    [
      ["event", true],
      ["depth", false],
    ]
  );
  assert.equal(json?.integration_types?.length, 2);
});

test("adds a guild-scoped registration when GUILD_ID is set", () => {
  env.GUILD_ID = "guild-42";
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(chatInput.length, 2);
  assert.deepEqual(chatInput[0]?.options, { guildIds: ["guild-42"] });
});

// chatInputRun

test("reports an event that is not in this Logbook", async () => {
  const interaction = makeInteraction({
    guildId: "guild-none",
    options: { integers: { event: 4242 } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(interaction.deferReply.mock.calls.length, 1);
  assert.equal(lastReplyText(interaction), "That event isn't in this Logbook.");
});

test("refuses to cross scopes", async () => {
  const [eventId] = await seedEvents(
    { guildId: "guild-a", channelId: "chan-a" },
    [{ summary: "A guild-a decision" }]
  );
  const interaction = makeInteraction({
    guildId: "guild-b",
    channelId: "chan-b",
    options: { integers: { event: eventId as number } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(lastReplyText(interaction), "That event isn't in this Logbook.");
});

test("renders an isolated event with no links and no evidence", async () => {
  const scope = { guildId: "guild-bare", channelId: "chan-bare" };
  const [eventId] = await seedEvents(scope, [{ summary: "A lonely decision" }]);
  const interaction = makeInteraction({
    ...scope,
    options: { integers: { event: eventId as number } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    [
      `## The Wake of event #${eventId}`,
      "**decision · Ship the release**",
      "A lonely decision",
      "",
      "### Connections",
      "No causal links have been recorded yet.",
      "",
      "### Evidence",
      "No source messages are attached.",
    ].join("\n")
  );
});

test("labels known relations and includes the rationale", async () => {
  const scope = { guildId: "guild-links", channelId: "chan-links" };
  const [root, other] = await seedEvents(scope, [
    { summary: "Chose Postgres" },
    { summary: "Benchmarked both engines" },
  ]);
  await logbook.linkStorylineEvents({
    ...scope,
    fromEventId: root as number,
    toEventId: other as number,
    relation: "caused_by",
    rationale: "r".repeat(200),
  });
  const interaction = makeInteraction({
    ...scope,
    options: { integers: { event: root as number } },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.match(
    reply,
    new RegExp(`\\*\\*#${root}\\*\\* was caused by \\*\\*#${other}\\*\\*`)
  );
  assert.match(reply, new RegExp(`> ${"r".repeat(179)}…`));
  assert.match(reply, /-# Chose Postgres → Benchmarked both engines/);
});

test("falls back to the raw relation name for an unrecognised relation", async () => {
  const scope = { guildId: "guild-odd", channelId: "chan-odd" };
  const [root, other] = await seedEvents(scope, [
    { summary: "Root event" },
    { summary: "Other event" },
  ]);
  // written straight to the table: the helper only accepts known relations
  await db.insert(storylineEventLinks).values({
    fromEventId: root as number,
    toEventId: other as number,
    relation: "inspired_by",
  });
  const interaction = makeInteraction({
    ...scope,
    options: { integers: { event: root as number } },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.match(
    reply,
    new RegExp(`\\*\\*#${root}\\*\\* inspired_by \\*\\*#${other}\\*\\*`)
  );
  // no rationale was stored, so no quote block follows the link
  assert.ok(!reply.includes("\n> "));
});

test("lists the primary source and an attached source as evidence", async () => {
  const scope = { guildId: null, channelId: "dm-evidence" };
  const primaryId = await seedMessage(
    scope,
    `primary\nsource ${"p".repeat(300)}`
  );
  const extraId = await seedMessage(scope, "an extra corroborating message");
  const [eventId] = await seedEvents(scope, [
    { summary: "Backed by messages", sourceMessageId: primaryId },
  ]);
  assert.equal(
    await logbook.addStorylineEventSource({
      ...scope,
      eventId: eventId as number,
      messageId: extraId,
      note: "quoted in the thread",
    }),
    true
  );
  const interaction = makeInteraction({
    guildId: null,
    channelId: "dm-evidence",
    options: { integers: { event: eventId as number } },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  // newlines are flattened and the excerpt clipped to 260 chars
  assert.match(reply, /> primary source p{2,}…\n-# Primary source/);
  assert.match(
    reply,
    /> an extra corroborating message\n-# quoted in the thread/
  );
});

test("passes the requested depth through to the graph walk", async () => {
  const scope = { guildId: "guild-depth", channelId: "chan-depth" };
  const [a, b, c] = await seedEvents(scope, [
    { summary: "Event A" },
    { summary: "Event B" },
    { summary: "Event C" },
  ]);
  await logbook.linkStorylineEvents({
    ...scope,
    fromEventId: a as number,
    toEventId: b as number,
    relation: "supports",
  });
  await logbook.linkStorylineEvents({
    ...scope,
    fromEventId: b as number,
    toEventId: c as number,
    relation: "supports",
  });

  const shallow = makeInteraction({
    ...scope,
    options: { integers: { event: a as number, depth: 1 } },
  });
  await command.chatInputRun(shallow as never);
  const shallowReply = lastReplyText(shallow);
  assert.match(shallowReply, new RegExp(`#${a}\\*\\* supports \\*\\*#${b}`));
  assert.ok(!shallowReply.includes(`#${b}** supports **#${c}`));

  const deep = makeInteraction({
    ...scope,
    options: { integers: { event: a as number } },
  });
  await command.chatInputRun(deep as never);
  assert.match(
    lastReplyText(deep),
    new RegExp(`#${b}\\*\\* supports \\*\\*#${c}`)
  );
});

test("caps the reply at Discord's message limit", async () => {
  const scope = { guildId: "guild-huge", channelId: "chan-huge" };
  const ids = await seedEvents(
    scope,
    Array.from({ length: 12 }, (_, i) => ({ summary: `Event ${i}` }))
  );
  const [root, ...rest] = ids;
  for (const id of rest) {
    await logbook.linkStorylineEvents({
      ...scope,
      fromEventId: root as number,
      toEventId: id as number,
      relation: "supports",
      rationale: "R".repeat(180),
    });
  }
  const interaction = makeInteraction({
    ...scope,
    options: { integers: { event: root as number } },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.equal(reply.length, 2000);
  assert.ok(reply.endsWith("…"));
});
