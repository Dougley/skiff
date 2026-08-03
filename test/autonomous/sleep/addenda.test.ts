import assert from "node:assert/strict";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

// Cap at 2 so truncation is observable with tiny fixtures.
bootstrapTestEnv({ SLEEP_MAX_ADDENDA_PER_SCOPE: "2" });

const { runMigrations } = await import("../../../src/db/migrate.js");
await runMigrations();
const addenda = await import("../../../src/autonomous/sleep/addenda.js");
const { db, personaAddenda } = await import("../../../src/db/index.js");
const { eq } = await import("drizzle-orm");
const { logger } = await import("../../../src/config/logger.js");

let clock = Date.now() - 60_000;

async function insertAddendum(
  text: string,
  scope: {
    guildId?: string | null;
    channelId?: string | null;
    active?: boolean;
  } = {}
): Promise<number> {
  // explicit, strictly increasing createdAt so oldest→newest order is stable
  clock += 1000;
  const [row] = await db
    .insert(personaAddenda)
    .values({
      guildId: scope.guildId ?? null,
      channelId: scope.channelId ?? null,
      text,
      active: scope.active ?? true,
      createdAt: new Date(clock),
    })
    .returning();
  assert.ok(row);
  return row.id;
}

test("loadAddendaCache buckets rows by scope and skips inactive ones", async () => {
  await insertAddendum("global note");
  await insertAddendum("guild note", { guildId: "g1" });
  await insertAddendum("channel note", { channelId: "c1" });
  await insertAddendum("retired note", { guildId: "g1", active: false });

  await addenda.loadAddendaCache();

  assert.deepEqual(addenda.getActiveAddenda("g1"), {
    global: ["global note"],
    guild: ["guild note"],
    channel: [],
  });
  assert.deepEqual(addenda.getActiveAddenda(null, "c1"), {
    global: ["global note"],
    guild: [],
    channel: ["channel note"],
  });
});

test("a guild context never sees channel notes, even when a channelId is passed", async () => {
  await addenda.loadAddendaCache();
  const result = addenda.getActiveAddenda("g1", "c1");
  assert.deepEqual(result.channel, []);
  assert.deepEqual(result.guild, ["guild note"]);
});

test("a scopeless context gets only global notes", async () => {
  await addenda.loadAddendaCache();
  const result = addenda.getActiveAddenda();
  assert.deepEqual(result.guild, []);
  assert.deepEqual(result.channel, []);
  assert.deepEqual(result.global, ["global note"]);
});

test("unknown scopes come back empty rather than undefined", async () => {
  await addenda.loadAddendaCache();
  assert.deepEqual(addenda.getActiveAddenda("nope").guild, []);
  assert.deepEqual(addenda.getActiveAddenda(null, "nope").channel, []);
});

test("each scope is capped at the most recent N addenda", async () => {
  await insertAddendum("cap old", { guildId: "cap-g" });
  await insertAddendum("cap mid", { guildId: "cap-g" });
  await insertAddendum("cap new", { guildId: "cap-g" });
  await addenda.loadAddendaCache();

  // SLEEP_MAX_ADDENDA_PER_SCOPE=2 → the oldest entry falls off
  assert.deepEqual(addenda.getActiveAddenda("cap-g").guild, [
    "cap mid",
    "cap new",
  ]);
});

test("refreshAddendaCache with no arguments reloads everything", async () => {
  await addenda.loadAddendaCache();
  await insertAddendum("late global");
  await insertAddendum("late guild", { guildId: "late-g" });

  await addenda.refreshAddendaCache();

  assert.ok(addenda.getActiveAddenda().global.includes("late global"));
  assert.deepEqual(addenda.getActiveAddenda("late-g").guild, ["late guild"]);
});

test("refreshing a guild scope picks up retirements and drops empty scopes", async () => {
  const first = await insertAddendum("keep me", { guildId: "refresh-g" });
  const second = await insertAddendum("retire me", { guildId: "refresh-g" });
  await addenda.loadAddendaCache();
  assert.equal(addenda.getActiveAddenda("refresh-g").guild.length, 2);

  await db
    .update(personaAddenda)
    .set({ active: false })
    .where(eq(personaAddenda.id, second));
  await addenda.refreshAddendaCache("refresh-g");
  assert.deepEqual(addenda.getActiveAddenda("refresh-g").guild, ["keep me"]);

  await db
    .update(personaAddenda)
    .set({ active: false })
    .where(eq(personaAddenda.id, first));
  await addenda.refreshAddendaCache("refresh-g");
  assert.deepEqual(addenda.getActiveAddenda("refresh-g").guild, []);
});

test("refreshing a channel scope works the same way", async () => {
  const id = await insertAddendum("dm note", { channelId: "refresh-c" });
  await addenda.loadAddendaCache();
  assert.deepEqual(addenda.getActiveAddenda(null, "refresh-c").channel, [
    "dm note",
  ]);

  await db
    .update(personaAddenda)
    .set({ active: false })
    .where(eq(personaAddenda.id, id));
  await addenda.refreshAddendaCache(undefined, "refresh-c");
  assert.deepEqual(addenda.getActiveAddenda(null, "refresh-c").channel, []);
});

test("refreshing a channel scope keeps the notes that survived", async () => {
  const keep = await insertAddendum("dm keeper", { channelId: "refresh-c2" });
  const drop = await insertAddendum("dm goner", { channelId: "refresh-c2" });
  await addenda.loadAddendaCache();
  assert.equal(addenda.getActiveAddenda(null, "refresh-c2").channel.length, 2);

  await db
    .update(personaAddenda)
    .set({ active: false })
    .where(eq(personaAddenda.id, drop));
  await addenda.refreshAddendaCache(undefined, "refresh-c2");

  assert.deepEqual(addenda.getActiveAddenda(null, "refresh-c2").channel, [
    "dm keeper",
  ]);
  assert.ok(keep > 0);
});

test("explicit nulls refresh only the global scope", async () => {
  await addenda.loadAddendaCache();
  await insertAddendum("fresh global");
  await insertAddendum("fresh guild", { guildId: "stale-g" });

  await addenda.refreshAddendaCache(null, null);

  // global picked up the new row; the guild cache was deliberately untouched
  assert.ok(addenda.getActiveAddenda().global.includes("fresh global"));
  assert.deepEqual(addenda.getActiveAddenda("stale-g").guild, []);
});

test("refresh failures warn and leave the cache intact", async () => {
  await insertAddendum("survivor", { guildId: "survive-g" });
  await addenda.loadAddendaCache();

  const warnings: unknown[] = [];
  const realWarn = logger.warn;
  const realSelect = db.select;
  logger.warn = ((message: unknown) => {
    warnings.push(message);
  }) as typeof logger.warn;
  (db as { select: unknown }).select = () => {
    throw new Error("db down");
  };
  try {
    await addenda.refreshAddendaCache("survive-g");
  } finally {
    (db as { select: unknown }).select = realSelect;
    logger.warn = realWarn;
  }

  assert.ok(
    warnings.some((w) => String(w).includes("refreshAddendaCache failed"))
  );
  assert.deepEqual(addenda.getActiveAddenda("survive-g").guild, ["survivor"]);
});

test("a failed full load resets the cache to empty instead of throwing", async () => {
  await addenda.loadAddendaCache();
  assert.ok(addenda.getActiveAddenda().global.length > 0);

  const warnings: unknown[] = [];
  const realWarn = logger.warn;
  const realSelect = db.select;
  logger.warn = ((message: unknown) => {
    warnings.push(message);
  }) as typeof logger.warn;
  (db as { select: unknown }).select = () => {
    throw new Error("db down");
  };
  try {
    await addenda.loadAddendaCache();
  } finally {
    (db as { select: unknown }).select = realSelect;
    logger.warn = realWarn;
  }

  assert.ok(
    warnings.some((w) => String(w).includes("loadAddendaCache failed"))
  );
  const result = addenda.getActiveAddenda("g1", "c1");
  assert.deepEqual(result, { global: [], guild: [], channel: [] });
});
