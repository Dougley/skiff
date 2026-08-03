import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

let userFactsModule: typeof import("../../../src/ai/memory/user-facts.js");
let dbModule: typeof import("../../../src/db/index.js");

beforeAll(async () => {
  const [{ runMigrations }, facts, db] = await Promise.all([
    import("../../../src/db/migrate.js"),
    import("../../../src/ai/memory/user-facts.js"),
    import("../../../src/db/index.js"),
  ]);
  await runMigrations();
  userFactsModule = facts;
  dbModule = db;

  await dbModule.db.insert(dbModule.userFacts).values([
    // global fact: visible everywhere
    { userId: "u1", fact: "global: prefers metric units", confidence: 90 },
    // guild fact
    {
      userId: "u1",
      guildId: "guild-1",
      fact: "guild: moderates #general",
      confidence: 70,
    },
    // DM channel fact
    {
      userId: "u1",
      channelId: "dm-1",
      fact: "dm: drafting a resignation letter",
      confidence: 60,
    },
    // other guild's fact — never visible in guild-1
    {
      userId: "u1",
      guildId: "guild-2",
      fact: "other-guild: runs the book club",
      confidence: 95,
    },
    // inactive fact — never returned
    {
      userId: "u1",
      guildId: "guild-1",
      fact: "stale: used to prefer imperial",
      active: false,
      confidence: 99,
    },
    // another user's fact — never returned for u1
    { userId: "u2", fact: "someone else's fact", confidence: 99 },
  ]);
});

test("a guild context sees guild facts plus global facts only", async () => {
  const facts = await userFactsModule.fetchUserFacts({
    userId: "u1",
    guildId: "guild-1",
    channelId: "some-channel",
  });
  assert.deepEqual(
    new Set(facts),
    new Set(["global: prefers metric units", "guild: moderates #general"])
  );
});

test("a DM context sees that channel's facts plus global facts only", async () => {
  const facts = await userFactsModule.fetchUserFacts({
    userId: "u1",
    guildId: null,
    channelId: "dm-1",
  });
  assert.deepEqual(
    new Set(facts),
    new Set([
      "global: prefers metric units",
      "dm: drafting a resignation letter",
    ])
  );
});

test("with neither guild nor channel only global facts surface", async () => {
  const facts = await userFactsModule.fetchUserFacts({ userId: "u1" });
  assert.deepEqual(facts, ["global: prefers metric units"]);
});

test("inactive facts and other users' facts never surface", async () => {
  const facts = await userFactsModule.fetchUserFacts({
    userId: "u1",
    guildId: "guild-1",
  });
  assert.ok(!facts.some((fact) => fact.startsWith("stale:")));
  assert.ok(!facts.includes("someone else's fact"));
});

test("facts come back ordered by confidence and the limit is honoured", async () => {
  const ordered = await userFactsModule.fetchUserFacts({
    userId: "u1",
    guildId: "guild-1",
  });
  assert.deepEqual(ordered, [
    "global: prefers metric units",
    "guild: moderates #general",
  ]);

  const limited = await userFactsModule.fetchUserFacts({
    userId: "u1",
    guildId: "guild-1",
    limit: 1,
  });
  assert.deepEqual(limited, ["global: prefers metric units"]);
});
