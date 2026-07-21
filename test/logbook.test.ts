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
