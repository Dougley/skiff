import assert from "node:assert/strict";
import { beforeEach, type Mock, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

// Every phase is stubbed: run.ts is the orchestrator, and the phases
// themselves are covered elsewhere.
type Ctx = import("../../../src/autonomous/sleep/context.js").DreamContext;
const phaseCalls: { name: string; ctx: Ctx }[] = [];
const stub = (name: string) =>
  vi.fn(async (ctx: Ctx) => {
    phaseCalls.push({ name, ctx });
  });

vi.mock("../../../src/autonomous/sleep/phases/consolidate-facts.js", () => ({
  consolidateFacts: stub("consolidate_facts"),
}));
vi.mock("../../../src/autonomous/sleep/phases/dedupe-topics.js", () => ({
  dedupeTopics: stub("dedupe_topics"),
}));
vi.mock("../../../src/autonomous/sleep/phases/synthesize-topics.js", () => ({
  synthesizeTopics: stub("synthesize_topics"),
}));
vi.mock("../../../src/autonomous/sleep/phases/trace-wake.js", () => ({
  traceWake: stub("trace_wake"),
}));
vi.mock("../../../src/autonomous/sleep/phases/reflect-persona.js", () => ({
  reflectPersona: stub("reflect_persona"),
}));
vi.mock("../../../src/autonomous/sleep/phases/propose-skills.js", () => ({
  proposeSkills: stub("propose_skills"),
}));

const { runMigrations } = await import("../../../src/db/migrate.js");
await runMigrations();
const { executeDreamPass } = await import(
  "../../../src/autonomous/sleep/run.js"
);
const { db, sleepCycleRuns, sleepCycleSettings } = await import(
  "../../../src/db/index.js"
);
const { consolidateFacts } = await import(
  "../../../src/autonomous/sleep/phases/consolidate-facts.js"
);
const { reflectPersona } = await import(
  "../../../src/autonomous/sleep/phases/reflect-persona.js"
);
const { proposeSkills } = await import(
  "../../../src/autonomous/sleep/phases/propose-skills.js"
);
const { eq } = await import("drizzle-orm");

const consolidateFactsMock = consolidateFacts as unknown as Mock;
const reflectPersonaMock = reflectPersona as unknown as Mock;
const proposeSkillsMock = proposeSkills as unknown as Mock;

beforeEach(() => {
  phaseCalls.length = 0;
  consolidateFactsMock.mockReset();
  consolidateFactsMock.mockImplementation(async (ctx: Ctx) => {
    phaseCalls.push({ name: "consolidate_facts", ctx });
  });
  reflectPersonaMock.mockReset();
  reflectPersonaMock.mockImplementation(async (ctx: Ctx) => {
    phaseCalls.push({ name: "reflect_persona", ctx });
  });
  proposeSkillsMock.mockReset();
  proposeSkillsMock.mockImplementation(async (ctx: Ctx) => {
    phaseCalls.push({ name: "propose_skills", ctx });
  });
});

async function seedSettings(fields: {
  guildId?: string | null;
  channelId?: string | null;
  dryRun?: boolean;
  autoAuthorSkills?: boolean;
}): Promise<void> {
  await db.insert(sleepCycleSettings).values({
    guildId: fields.guildId ?? null,
    channelId: fields.channelId ?? null,
    enabled: true,
    dryRun: fields.dryRun ?? true,
    autoAuthorSkills: fields.autoAuthorSkills ?? false,
  });
}

async function runRow(id: number) {
  const [row] = await db
    .select()
    .from(sleepCycleRuns)
    .where(eq(sleepCycleRuns.id, id));
  assert.ok(row);
  return row;
}

test("a pass runs every phase in order and records a succeeded run", async () => {
  await seedSettings({ guildId: "run-g1", dryRun: false });

  const result = await executeDreamPass({
    guildId: "run-g1",
    triggerReason: "scheduled",
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.dryRun, false);
  assert.deepEqual(
    phaseCalls.map((c) => c.name),
    [
      "consolidate_facts",
      "dedupe_topics",
      "synthesize_topics",
      "trace_wake",
      "reflect_persona",
    ]
  );

  const row = await runRow(result.runId);
  assert.equal(row.status, "succeeded");
  assert.equal(row.guildId, "run-g1");
  assert.equal(row.channelId, null);
  assert.equal(row.dryRun, false);
  assert.equal(row.triggerReason, "scheduled");
  assert.ok(row.finishedAt);
  assert.equal(row.error, null);
});

test("every phase shares one context carrying the run id and scope", async () => {
  await seedSettings({ guildId: "run-g2", dryRun: true });

  const before = Date.now();
  const result = await executeDreamPass({
    guildId: "run-g2",
    triggerReason: "manual",
  });

  const contexts = new Set(phaseCalls.map((c) => c.ctx));
  assert.equal(contexts.size, 1);
  const ctx = phaseCalls[0]?.ctx;
  assert.ok(ctx);
  assert.equal(ctx.runId, result.runId);
  assert.equal(ctx.guildId, "run-g2");
  assert.equal(ctx.channelId, null);
  assert.equal(ctx.dryRun, true);
  assert.equal(ctx.tokenUsage, 0);
  assert.ok(ctx.now.getTime() >= before);
});

test("phase stats and token usage are persisted with the run", async () => {
  await seedSettings({ guildId: "run-g3" });
  consolidateFactsMock.mockImplementation(async (ctx: Ctx) => {
    ctx.phaseStats.consolidate_facts = { resolutions: 2 };
    ctx.tokenUsage += 1500;
  });

  const result = await executeDreamPass({
    guildId: "run-g3",
    triggerReason: "test",
  });

  assert.deepEqual(result.phaseStats.consolidate_facts, { resolutions: 2 });
  const row = await runRow(result.runId);
  assert.deepEqual(row.phaseStats?.consolidate_facts, { resolutions: 2 });
  assert.equal(row.tokenCost, 1500);
});

test("a pass that spent no tokens stores null rather than zero", async () => {
  await seedSettings({ guildId: "run-g4" });
  const result = await executeDreamPass({
    guildId: "run-g4",
    triggerReason: "test",
  });
  assert.equal((await runRow(result.runId)).tokenCost, null);
});

test("skill proposal is gated off unless the scope opted in", async () => {
  await seedSettings({ guildId: "run-g5", autoAuthorSkills: false });

  const result = await executeDreamPass({
    guildId: "run-g5",
    triggerReason: "scheduled",
  });

  assert.equal(proposeSkillsMock.mock.calls.length, 0);
  assert.deepEqual(result.phaseStats.propose_skills, { gatedOff: 1 });
});

test("scopes that opted into skill authoring get the propose phase", async () => {
  await seedSettings({ guildId: "run-g6", autoAuthorSkills: true });

  const result = await executeDreamPass({
    guildId: "run-g6",
    triggerReason: "scheduled",
  });

  assert.equal(proposeSkillsMock.mock.calls.length, 1);
  assert.equal(result.phaseStats.propose_skills, undefined);
});

test("explicit overrides beat the stored scope settings", async () => {
  await seedSettings({
    guildId: "run-g7",
    dryRun: false,
    autoAuthorSkills: false,
  });

  const result = await executeDreamPass({
    guildId: "run-g7",
    triggerReason: "manual",
    forceDryRun: true,
    forceAutoAuthorSkills: true,
  });

  assert.equal(result.dryRun, true);
  assert.equal((await runRow(result.runId)).dryRun, true);
  assert.equal(proposeSkillsMock.mock.calls.length, 1);
});

test("a DM pass reads settings by channel id", async () => {
  await seedSettings({
    channelId: "run-c1",
    dryRun: false,
    autoAuthorSkills: true,
  });

  const result = await executeDreamPass({
    guildId: null,
    channelId: "run-c1",
    triggerReason: "scheduled",
  });

  assert.equal(result.dryRun, false);
  assert.equal(proposeSkillsMock.mock.calls.length, 1);
  const row = await runRow(result.runId);
  assert.equal(row.channelId, "run-c1");
  assert.equal(row.guildId, null);
  assert.equal(phaseCalls[0]?.ctx.channelId, "run-c1");
});

test("an unconfigured scope falls back to the safe defaults", async () => {
  const result = await executeDreamPass({
    guildId: "run-unknown",
    triggerReason: "manual",
  });

  // dry run on, skills gated off — nothing gets applied without opt-in
  assert.equal(result.dryRun, true);
  assert.equal(proposeSkillsMock.mock.calls.length, 0);
});

test("a scopeless pass skips the settings lookup entirely", async () => {
  const result = await executeDreamPass({
    guildId: null,
    channelId: null,
    triggerReason: "test",
  });

  assert.equal(result.status, "succeeded");
  assert.equal(result.dryRun, true);
  const row = await runRow(result.runId);
  assert.equal(row.guildId, null);
  assert.equal(row.channelId, null);
});

test("a throwing phase fails the run and records the error", async () => {
  await seedSettings({ guildId: "run-g8" });
  consolidateFactsMock.mockImplementation(async (ctx: Ctx) => {
    ctx.phaseStats.consolidate_facts = { resolutions: 1 };
  });
  reflectPersonaMock.mockRejectedValueOnce(new Error("model exploded"));

  const result = await executeDreamPass({
    guildId: "run-g8",
    triggerReason: "scheduled",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error, "model exploded");
  // partial stats from the phases that did finish survive
  assert.deepEqual(result.phaseStats.consolidate_facts, { resolutions: 1 });
  // the later phase never ran
  assert.equal(proposeSkillsMock.mock.calls.length, 0);

  const row = await runRow(result.runId);
  assert.equal(row.status, "failed");
  assert.equal(row.error, "model exploded");
  assert.ok(row.finishedAt);
  assert.deepEqual(row.phaseStats?.consolidate_facts, { resolutions: 1 });
});

test("a non-Error throw is stringified into the run error", async () => {
  await seedSettings({ guildId: "run-g9" });
  consolidateFactsMock.mockRejectedValueOnce("just a string");

  const result = await executeDreamPass({
    guildId: "run-g9",
    triggerReason: "test",
  });

  assert.equal(result.status, "failed");
  assert.equal(result.error, "just a string");
  assert.equal((await runRow(result.runId)).error, "just a string");
});

test("a run row that cannot be created aborts the pass", async () => {
  const realInsert = db.insert;
  (db as { insert: unknown }).insert = () => ({
    values: () => ({ returning: async () => [] }),
  });
  try {
    await assert.rejects(
      executeDreamPass({ guildId: "run-g10", triggerReason: "manual" }),
      /failed to create run row/
    );
  } finally {
    (db as { insert: unknown }).insert = realInsert;
  }
  assert.equal(phaseCalls.length, 0);
});
