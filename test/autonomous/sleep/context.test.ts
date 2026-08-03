import assert from "node:assert/strict";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { runMigrations } = await import("../../../src/db/migrate.js");
await runMigrations();
const { addStat, logChange } = await import(
  "../../../src/autonomous/sleep/context.js"
);
type DreamContext =
  import("../../../src/autonomous/sleep/context.js").DreamContext;
const { db, sleepCycleChanges, sleepCycleRuns } = await import(
  "../../../src/db/index.js"
);
const { eq } = await import("drizzle-orm");
const { logger } = await import("../../../src/config/logger.js");

async function createRun(): Promise<number> {
  const [run] = await db
    .insert(sleepCycleRuns)
    .values({ guildId: "g", status: "running", triggerReason: "test" })
    .returning();
  assert.ok(run);
  return run.id;
}

function makeCtx(): DreamContext {
  return {
    runId: 1,
    guildId: null,
    channelId: null,
    dryRun: true,
    phaseStats: {},
    tokenUsage: 0,
    now: new Date(),
  };
}

test("logChange records a full change row and returns its id", async () => {
  const runId = await createRun();
  const id = await logChange({
    runId,
    kind: "fact_resolve",
    targetTable: "user_facts",
    targetId: 42,
    before: { retireIds: [1, 2], keepId: 3 },
    after: { kept: 3 },
  });

  assert.ok(id !== null && id > 0);
  const [row] = await db
    .select()
    .from(sleepCycleChanges)
    .where(eq(sleepCycleChanges.id, id));
  assert.ok(row);
  assert.equal(row.runId, runId);
  assert.equal(row.kind, "fact_resolve");
  assert.equal(row.targetTable, "user_facts");
  // numeric target ids are stringified for the text column
  assert.equal(row.targetId, "42");
  assert.deepEqual(row.before, { retireIds: [1, 2], keepId: 3 });
  assert.deepEqual(row.after, { kept: 3 });
  assert.equal(row.reverted, false);
});

test("logChange defaults every optional field to null", async () => {
  const runId = await createRun();
  const id = await logChange({ runId, kind: "topic_new" });

  assert.ok(id !== null);
  const [row] = await db
    .select()
    .from(sleepCycleChanges)
    .where(eq(sleepCycleChanges.id, id));
  assert.ok(row);
  assert.equal(row.targetTable, null);
  assert.equal(row.targetId, null);
  assert.equal(row.before, null);
  assert.equal(row.after, null);
});

test("logChange keeps an explicit null targetId as null, not the string 'null'", async () => {
  const runId = await createRun();
  const id = await logChange({
    runId,
    kind: "persona_addendum",
    targetId: null,
  });
  assert.ok(id !== null);
  const [row] = await db
    .select()
    .from(sleepCycleChanges)
    .where(eq(sleepCycleChanges.id, id));
  assert.equal(row?.targetId, null);
});

test("logChange swallows database failures and returns null", async () => {
  const warnings: unknown[] = [];
  const realWarn = logger.warn;
  logger.warn = ((message: unknown, fields?: Record<string, unknown>) => {
    warnings.push({ message, ...fields });
  }) as typeof logger.warn;
  try {
    // violates the run_id foreign key — the insert must fail
    const id = await logChange({ runId: 999_999, kind: "wake_link" });
    assert.equal(id, null);
  } finally {
    logger.warn = realWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(
    String((warnings[0] as { message: string }).message),
    /logChange failed/
  );
});

test("logChange returns null when the insert yields no row", async () => {
  const realInsert = db.insert;
  (db as { insert: unknown }).insert = () => ({
    values: () => ({ returning: async () => [] }),
  });
  try {
    assert.equal(await logChange({ runId: 1, kind: "topic_merge" }), null);
  } finally {
    (db as { insert: unknown }).insert = realInsert;
  }
});

test("addStat creates the phase bucket on first use", () => {
  const ctx = makeCtx();
  addStat(ctx, "consolidate_facts", "resolutions");
  assert.deepEqual(ctx.phaseStats, { consolidate_facts: { resolutions: 1 } });
});

test("addStat accumulates repeated increments", () => {
  const ctx = makeCtx();
  addStat(ctx, "dedupe_topics", "merges");
  addStat(ctx, "dedupe_topics", "merges");
  addStat(ctx, "dedupe_topics", "merges");
  assert.equal(ctx.phaseStats.dedupe_topics?.merges, 3);
});

test("addStat supports explicit deltas, including negative ones", () => {
  const ctx = makeCtx();
  addStat(ctx, "synthesize_topics", "topicsCreated", 5);
  addStat(ctx, "synthesize_topics", "topicsCreated", -2);
  assert.equal(ctx.phaseStats.synthesize_topics?.topicsCreated, 3);
});

test("addStat keeps phases and keys independent", () => {
  const ctx = makeCtx();
  addStat(ctx, "a", "x");
  addStat(ctx, "a", "y", 2);
  addStat(ctx, "b", "x", 7);
  assert.deepEqual(ctx.phaseStats, { a: { x: 1, y: 2 }, b: { x: 7 } });
});
