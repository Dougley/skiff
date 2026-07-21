import assert from "node:assert/strict";
import { before, test } from "node:test";

process.env.DISCORD_BOT_TOKEN = `${Buffer.from("123456789012345678").toString("base64")}.test.signature`;
process.env.OPENAI_API_KEY = "test";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.DATABASE_URL = "memory://";

let logbook: typeof import("../src/ai/logbook/store.js");

before(async () => {
  const [{ runMigrations }, store] = await Promise.all([
    import("../src/db/migrate.js"),
    import("../src/ai/logbook/store.js"),
  ]);
  await runMigrations();
  logbook = store;
});

test("keeps guild and DM storylines in their own scopes", async () => {
  const guildStoryline = await logbook.createStoryline({
    guildId: "guild-a",
    channelId: "guild-channel",
    title: "Ship the release",
    goal: "Publish version 0.2",
    currentState: "Preparing the release candidate",
    createdByUserId: "user-a",
  });
  const dmStoryline = await logbook.createStoryline({
    guildId: null,
    channelId: "dm-a",
    title: "Private launch notes",
    goal: "Prepare a private announcement",
    currentState: "Drafting",
    createdByUserId: "user-a",
  });

  assert.deepEqual(
    (
      await logbook.listStorylines({ guildId: "guild-a", channelId: "other" })
    ).map((row) => row.id),
    [guildStoryline.id]
  );
  assert.deepEqual(
    (await logbook.listStorylines({ guildId: null, channelId: "dm-a" })).map(
      (row) => row.id
    ),
    [dmStoryline.id]
  );
  assert.equal(
    await logbook.getStoryline(
      { guildId: null, channelId: "dm-b" },
      dmStoryline.id
    ),
    null
  );
});

test("records state changes and resolves open loops without erasing history", async () => {
  const scope = { guildId: "guild-events", channelId: "channel" };
  const storyline = await logbook.createStoryline({
    ...scope,
    title: "Choose a deployment target",
    goal: "Select and validate hosting",
    currentState: "Options are under review",
  });
  const recorded = await logbook.recordStorylineEvent({
    ...scope,
    storylineId: storyline.id,
    kind: "open_question",
    summary: "Can the target run PGlite safely?",
    currentState: "Validating persistent storage on the leading target",
    ownerUserId: "user-b",
  });

  assert.ok(recorded);
  assert.equal(
    recorded.storyline.currentState,
    "Validating persistent storage on the leading target"
  );
  assert.equal(recorded.event.status, "active");

  const resolved = await logbook.resolveStorylineEvent({
    ...scope,
    storylineId: storyline.id,
    eventId: recorded.event.id,
    resolution: "Persistent storage passed the restart test.",
  });
  assert.ok(resolved);

  const detail = await logbook.getStoryline(scope, storyline.id);
  assert.ok(detail);
  const original = detail.events.find(
    (event) => event.id === recorded.event.id
  );
  assert.equal(original?.status, "resolved");
  assert.ok(original?.resolvedAt);
  assert.ok(
    detail.events.some(
      (event) => event.summary === "Persistent storage passed the restart test."
    )
  );
});

test("retrieves a lexically relevant active storyline without embeddings", async () => {
  const scope = { guildId: "guild-relevance", channelId: "channel" };
  const release = await logbook.createStoryline({
    ...scope,
    title: "Skiff release",
    goal: "Publish the next Skiff version",
    currentState: "Docker verification remains",
    tags: ["release"],
  });
  await logbook.createStoryline({
    ...scope,
    title: "Community meetup",
    goal: "Plan a social event",
    currentState: "Looking for a venue",
  });

  const matches = await logbook.findRelevantStorylines(
    scope,
    "What remains for the Skiff release?"
  );
  assert.equal(matches[0]?.id, release.id);
  assert.ok(matches.every((row) => row.title !== "Community meetup"));
});

test("builds an evidence-backed Wake without crossing scopes", async () => {
  const scope = { guildId: "guild-wake", channelId: "channel" };
  const storyline = await logbook.createStoryline({
    ...scope,
    title: "Choose the database",
    goal: "Pick durable local storage",
    currentState: "PGlite is selected",
  });
  const constraint = await logbook.recordStorylineEvent({
    ...scope,
    storylineId: storyline.id,
    kind: "decision",
    summary: "Keep deployment self-contained",
  });
  const decision = await logbook.recordStorylineEvent({
    ...scope,
    storylineId: storyline.id,
    kind: "decision",
    summary: "Use PGlite for embedded persistence",
  });
  assert.ok(constraint && decision);

  const link = await logbook.linkStorylineEvents({
    ...scope,
    fromEventId: decision.event.id,
    relation: "caused_by",
    toEventId: constraint.event.id,
    rationale: "Embedded storage preserves the single-container deployment.",
  });
  assert.ok(link);

  const { db, conversations, messages } = await import("../src/db/index.js");
  const [conversation] = await db
    .insert(conversations)
    .values({
      channelId: "wake-evidence",
      guildId: "guild-wake",
      model: "test",
    })
    .returning();
  assert.ok(conversation);
  const [message] = await db
    .insert(messages)
    .values({
      conversationId: conversation.id,
      role: "user",
      content: "We need the service to remain self-contained.",
      userId: "user-wake",
    })
    .returning();
  assert.ok(message);
  assert.equal(
    await logbook.addStorylineEventSource({
      ...scope,
      eventId: constraint.event.id,
      messageId: message.id,
      note: "Constraint confirmed",
    }),
    true
  );
  const [foreignConversation] = await db
    .insert(conversations)
    .values({ channelId: "foreign", guildId: "other-guild", model: "test" })
    .returning();
  assert.ok(foreignConversation);
  const [foreignMessage] = await db
    .insert(messages)
    .values({
      conversationId: foreignConversation.id,
      role: "user",
      content: "Private evidence from another scope",
    })
    .returning();
  assert.ok(foreignMessage);
  assert.equal(
    await logbook.addStorylineEventSource({
      ...scope,
      eventId: constraint.event.id,
      messageId: foreignMessage.id,
    }),
    false
  );

  const wake = await logbook.getWake(scope, decision.event.id, 3);
  assert.ok(wake);
  assert.deepEqual(
    new Set(wake.nodes.map((node) => node.event.id)),
    new Set([decision.event.id, constraint.event.id])
  );
  assert.equal(wake.links[0]?.relation, "caused_by");
  assert.equal(
    wake.nodes.find((node) => node.event.id === constraint.event.id)
      ?.evidence[0]?.excerpt,
    "We need the service to remain self-contained."
  );

  assert.equal(
    await logbook.getWake(
      { guildId: "different-guild", channelId: "channel" },
      decision.event.id
    ),
    null
  );
});
