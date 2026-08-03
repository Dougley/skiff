import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, type Mock, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

// SKILLS_DIR must be pinned before env validation so the path guard in
// rollback.ts resolves against a directory this test controls.
const skillsRoot = await mkdtemp(join(tmpdir(), "skiff-skills-test-"));
bootstrapTestEnv({ SKILLS_DIR: skillsRoot });

vi.mock("../../../src/ai/skills/index.js", () => ({
  reloadSkills: vi.fn(async () => {}),
}));

const { runMigrations } = await import("../../../src/db/migrate.js");
await runMigrations();
const { rollbackChange, rollbackRun } = await import(
  "../../../src/autonomous/sleep/rollback.js"
);
const { loadAddendaCache, getActiveAddenda } = await import(
  "../../../src/autonomous/sleep/addenda.js"
);
const { reloadSkills } = await import("../../../src/ai/skills/index.js");
const reloadSkillsMock = reloadSkills as unknown as Mock;
const {
  db,
  personaAddenda,
  sleepCycleChanges,
  sleepCycleRuns,
  storylineEventLinks,
  storylineEvents,
  storylines,
  topicKnowledge,
  userFacts,
} = await import("../../../src/db/index.js");
const { eq } = await import("drizzle-orm");

afterAll(async () => {
  await rm(skillsRoot, { recursive: true, force: true });
});

async function createRun(): Promise<number> {
  const [run] = await db
    .insert(sleepCycleRuns)
    .values({ guildId: "g", status: "succeeded", triggerReason: "test" })
    .returning();
  assert.ok(run);
  return run.id;
}

async function addChange(
  runId: number,
  kind: string,
  fields: {
    targetId?: string | null;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    reverted?: boolean;
  } = {}
): Promise<number> {
  const [row] = await db
    .insert(sleepCycleChanges)
    .values({
      runId,
      kind,
      targetId: fields.targetId ?? null,
      before: fields.before ?? null,
      after: fields.after ?? null,
      reverted: fields.reverted ?? false,
    })
    .returning();
  assert.ok(row);
  return row.id;
}

async function changeRow(id: number) {
  const [row] = await db
    .select()
    .from(sleepCycleChanges)
    .where(eq(sleepCycleChanges.id, id));
  assert.ok(row);
  return row;
}

async function insertFact(fields: {
  active?: boolean;
  supersededBy?: number | null;
}): Promise<number> {
  const [row] = await db
    .insert(userFacts)
    .values({
      userId: "u1",
      fact: "some fact",
      active: fields.active ?? true,
      supersededBy: fields.supersededBy ?? null,
    })
    .returning();
  assert.ok(row);
  return row.id;
}

async function insertTopic(fields: {
  title?: string;
  summary?: string;
  tags?: string[];
  active?: boolean;
  supersededBy?: number | null;
}): Promise<number> {
  const [row] = await db
    .insert(topicKnowledge)
    .values({
      title: fields.title ?? "topic",
      summary: fields.summary ?? "summary",
      tags: fields.tags ?? [],
      active: fields.active ?? true,
      supersededBy: fields.supersededBy ?? null,
    })
    .returning();
  assert.ok(row);
  return row.id;
}

test("rolling back an unknown change id reports an error", async () => {
  const result = await rollbackChange(987_654);
  assert.deepEqual(result, {
    reverted: 0,
    skipped: 0,
    errors: ["change 987654 not found"],
  });
});

test("fact_resolve reactivates the retired facts and flags the change", async () => {
  const keepId = await insertFact({});
  const retiredA = await insertFact({ active: false, supersededBy: keepId });
  const retiredB = await insertFact({ active: false, supersededBy: keepId });
  const runId = await createRun();
  const changeId = await addChange(runId, "fact_resolve", {
    before: { retireIds: [retiredA, retiredB], keepId },
  });

  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 1, skipped: 0, errors: [] });

  for (const id of [retiredA, retiredB]) {
    const [fact] = await db
      .select()
      .from(userFacts)
      .where(eq(userFacts.id, id));
    assert.equal(fact?.active, true);
    assert.equal(fact?.supersededBy, null);
  }
  assert.equal((await changeRow(changeId)).reverted, true);
});

test("fact_resolve leaves facts that a later run re-resolved elsewhere", async () => {
  const keepId = await insertFact({});
  const otherKeep = await insertFact({});
  const stillOurs = await insertFact({ active: false, supersededBy: keepId });
  const movedOn = await insertFact({ active: false, supersededBy: otherKeep });
  const runId = await createRun();
  const changeId = await addChange(runId, "fact_resolve", {
    before: { retireIds: [stillOurs, movedOn], keepId },
  });

  const result = await rollbackChange(changeId);
  assert.equal(result.reverted, 1);

  const [ours] = await db
    .select()
    .from(userFacts)
    .where(eq(userFacts.id, stillOurs));
  assert.equal(ours?.active, true);
  const [moved] = await db
    .select()
    .from(userFacts)
    .where(eq(userFacts.id, movedOn));
  // resurrecting this one would clobber the later run's state
  assert.equal(moved?.active, false);
  assert.equal(moved?.supersededBy, otherKeep);
});

test("fact_resolve without usable before-state is skipped", async () => {
  const runId = await createRun();
  const noBefore = await addChange(runId, "fact_resolve", { before: null });
  const emptyIds = await addChange(runId, "fact_resolve", {
    before: { retireIds: [], keepId: 1 },
  });
  const noKeep = await addChange(runId, "fact_resolve", {
    before: { retireIds: [1] },
  });

  for (const id of [noBefore, emptyIds, noKeep]) {
    const result = await rollbackChange(id);
    assert.deepEqual(result, { reverted: 0, skipped: 1, errors: [] });
    assert.equal((await changeRow(id)).reverted, false);
  }
});

test("fact_resolve where every fact moved on flips nothing", async () => {
  const keepId = await insertFact({});
  const alreadyActive = await insertFact({ active: true, supersededBy: null });
  const runId = await createRun();
  const changeId = await addChange(runId, "fact_resolve", {
    before: { retireIds: [alreadyActive], keepId },
  });

  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 0, skipped: 1, errors: [] });
});

test("topic_merge restores the canonical topic and revives the loser", async () => {
  const canonicalId = await insertTopic({
    summary: "merged summary",
    tags: ["merged"],
  });
  const loserId = await insertTopic({
    summary: "loser summary",
    active: false,
    supersededBy: canonicalId,
  });
  const runId = await createRun();
  const changeId = await addChange(runId, "topic_merge", {
    targetId: String(loserId),
    before: {
      loser: { id: loserId, summary: "loser summary" },
      canonical: {
        id: canonicalId,
        summary: "original summary",
        tags: ["original"],
      },
    },
    after: { mergedSummary: "merged summary", mergedTags: ["merged"] },
  });

  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 1, skipped: 0, errors: [] });

  const [canonical] = await db
    .select()
    .from(topicKnowledge)
    .where(eq(topicKnowledge.id, canonicalId));
  assert.equal(canonical?.summary, "original summary");
  assert.deepEqual(canonical?.tags, ["original"]);
  const [loser] = await db
    .select()
    .from(topicKnowledge)
    .where(eq(topicKnowledge.id, loserId));
  assert.equal(loser?.active, true);
  assert.equal(loser?.supersededBy, null);
});

test("topic_merge does not clobber a canonical topic edited since the merge", async () => {
  const canonicalId = await insertTopic({ summary: "edited afterwards" });
  const loserId = await insertTopic({
    summary: "loser",
    active: false,
    supersededBy: canonicalId,
  });
  const runId = await createRun();
  const changeId = await addChange(runId, "topic_merge", {
    targetId: String(loserId),
    before: {
      loser: { id: loserId, summary: "loser" },
      canonical: { id: canonicalId, summary: "original", tags: ["t"] },
    },
    after: { mergedSummary: "merged summary" },
  });

  const result = await rollbackChange(changeId);
  // loser still comes back, so the change counts as reverted
  assert.equal(result.reverted, 1);

  const [canonical] = await db
    .select()
    .from(topicKnowledge)
    .where(eq(topicKnowledge.id, canonicalId));
  assert.equal(canonical?.summary, "edited afterwards");
  const [loser] = await db
    .select()
    .from(topicKnowledge)
    .where(eq(topicKnowledge.id, loserId));
  assert.equal(loser?.active, true);
});

test("topic_merge with nothing left to restore is skipped", async () => {
  const canonicalId = await insertTopic({ summary: "drifted" });
  const loserId = await insertTopic({ summary: "already back" }); // active again
  const runId = await createRun();
  const changeId = await addChange(runId, "topic_merge", {
    targetId: String(loserId),
    before: {
      loser: { id: loserId, summary: "already back" },
      canonical: { id: canonicalId, summary: "original", tags: ["t"] },
    },
    after: { mergedSummary: "merged summary" },
  });

  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 0, skipped: 1, errors: [] });
});

test("topic_merge without before-state is skipped", async () => {
  const runId = await createRun();
  const changeId = await addChange(runId, "topic_merge", {
    targetId: "1",
    before: { canonical: { id: 1 } }, // loser missing
  });
  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 0, skipped: 1, errors: [] });
});

test("topic_merge with no recorded canonical fields only revives the loser", async () => {
  const canonicalId = await insertTopic({ summary: "merged summary" });
  const loserId = await insertTopic({
    summary: "loser",
    active: false,
    supersededBy: canonicalId,
  });
  const runId = await createRun();
  const changeId = await addChange(runId, "topic_merge", {
    targetId: String(loserId),
    before: {
      loser: { id: loserId },
      canonical: { id: canonicalId }, // nothing to restore
    },
    after: { mergedSummary: "merged summary" },
  });

  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 1, skipped: 0, errors: [] });

  const [canonical] = await db
    .select()
    .from(topicKnowledge)
    .where(eq(topicKnowledge.id, canonicalId));
  assert.equal(canonical?.summary, "merged summary");
  const [loser] = await db
    .select()
    .from(topicKnowledge)
    .where(eq(topicKnowledge.id, loserId));
  assert.equal(loser?.active, true);
});

test("topic_merge restores tags even when no summary was recorded", async () => {
  const canonicalId = await insertTopic({
    summary: "merged summary",
    tags: ["merged"],
  });
  const loserId = await insertTopic({
    summary: "loser",
    active: false,
    supersededBy: canonicalId,
  });
  const runId = await createRun();
  const changeId = await addChange(runId, "topic_merge", {
    targetId: String(loserId),
    before: {
      loser: { id: loserId },
      canonical: { id: canonicalId, tags: ["original"] },
    },
    after: { mergedSummary: "merged summary" },
  });

  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 1, skipped: 0, errors: [] });

  const [canonical] = await db
    .select()
    .from(topicKnowledge)
    .where(eq(topicKnowledge.id, canonicalId));
  assert.deepEqual(canonical?.tags, ["original"]);
  assert.equal(canonical?.summary, "merged summary");
});

test("topic_new deactivates the created topic exactly once", async () => {
  const topicId = await insertTopic({});
  const runId = await createRun();
  const changeId = await addChange(runId, "topic_new", {
    targetId: String(topicId),
  });

  const first = await rollbackChange(changeId);
  assert.deepEqual(first, { reverted: 1, skipped: 0, errors: [] });
  const [topic] = await db
    .select()
    .from(topicKnowledge)
    .where(eq(topicKnowledge.id, topicId));
  assert.equal(topic?.active, false);

  // second attempt: the change is already flagged as reverted
  const second = await rollbackChange(changeId);
  assert.deepEqual(second, { reverted: 0, skipped: 1, errors: [] });
});

test("topic_new on an already-inactive topic is skipped", async () => {
  const topicId = await insertTopic({ active: false });
  const runId = await createRun();
  const changeId = await addChange(runId, "topic_new", {
    targetId: String(topicId),
  });
  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 0, skipped: 1, errors: [] });
});

test("persona_addendum retires the note and refreshes the prompt cache", async () => {
  const [addendum] = await db
    .insert(personaAddenda)
    .values({ guildId: "rb-guild", text: "be extra nautical", active: true })
    .returning();
  assert.ok(addendum);
  await loadAddendaCache();
  assert.deepEqual(getActiveAddenda("rb-guild").guild, ["be extra nautical"]);

  const runId = await createRun();
  const changeId = await addChange(runId, "persona_addendum", {
    targetId: String(addendum.id),
  });
  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 1, skipped: 0, errors: [] });

  const [row] = await db
    .select()
    .from(personaAddenda)
    .where(eq(personaAddenda.id, addendum.id));
  assert.equal(row?.active, false);
  assert.ok(row?.retiredAt);
  // the live cache no longer serves the retired note
  assert.deepEqual(getActiveAddenda("rb-guild").guild, []);
});

test("wake_link deletes the causal link", async () => {
  const [storyline] = await db
    .insert(storylines)
    .values({ title: "t", goal: "g", currentState: "s" })
    .returning();
  assert.ok(storyline);
  const [from] = await db
    .insert(storylineEvents)
    .values({ storylineId: storyline.id, kind: "decision", summary: "a" })
    .returning();
  const [to] = await db
    .insert(storylineEvents)
    .values({ storylineId: storyline.id, kind: "decision", summary: "b" })
    .returning();
  assert.ok(from && to);
  const [link] = await db
    .insert(storylineEventLinks)
    .values({ fromEventId: from.id, toEventId: to.id, relation: "caused_by" })
    .returning();
  assert.ok(link);

  const runId = await createRun();
  const changeId = await addChange(runId, "wake_link", {
    targetId: String(link.id),
  });
  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 1, skipped: 0, errors: [] });
  const remaining = await db
    .select()
    .from(storylineEventLinks)
    .where(eq(storylineEventLinks.id, link.id));
  assert.equal(remaining.length, 0);
});

test("wake_link for an already-deleted link is skipped", async () => {
  const runId = await createRun();
  const changeId = await addChange(runId, "wake_link", {
    targetId: "999999",
  });
  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 0, skipped: 1, errors: [] });
});

test("skill_author deletes the authored directory and reloads skills", async () => {
  const skillDir = join(skillsRoot, "authored-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "---\nname: authored\n---\n");

  reloadSkillsMock.mockClear();
  const runId = await createRun();
  const changeId = await addChange(runId, "skill_author", {
    targetId: skillDir,
  });
  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 1, skipped: 0, errors: [] });
  await assert.rejects(access(skillDir));
  assert.equal(reloadSkillsMock.mock.calls.length, 1);
  assert.equal(reloadSkillsMock.mock.calls[0]?.[0], skillsRoot);
});

test("skill_author refuses paths outside SKILLS_DIR", async () => {
  const outside = await mkdtemp(join(tmpdir(), "skiff-outside-"));
  try {
    reloadSkillsMock.mockClear();
    const runId = await createRun();
    const changeId = await addChange(runId, "skill_author", {
      targetId: outside,
    });
    const result = await rollbackChange(changeId);
    assert.deepEqual(result, { reverted: 0, skipped: 1, errors: [] });
    // the directory is untouched and no reload happened
    await access(outside);
    assert.equal(reloadSkillsMock.mock.calls.length, 0);
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});

test("skill_author refuses the skills root itself", async () => {
  const runId = await createRun();
  const changeId = await addChange(runId, "skill_author", {
    targetId: skillsRoot,
  });
  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 0, skipped: 1, errors: [] });
  await access(skillsRoot);
});

test("skill_author is skipped when the reload fails", async () => {
  const skillDir = join(skillsRoot, "reload-fails");
  await mkdir(skillDir, { recursive: true });
  reloadSkillsMock.mockRejectedValueOnce(new Error("loader broke"));

  const runId = await createRun();
  const changeId = await addChange(runId, "skill_author", {
    targetId: skillDir,
  });
  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 0, skipped: 1, errors: [] });
  assert.equal((await changeRow(changeId)).reverted, false);
});

test("an unknown change kind is skipped", async () => {
  const runId = await createRun();
  const changeId = await addChange(runId, "mystery_kind", { targetId: "1" });
  const result = await rollbackChange(changeId);
  assert.deepEqual(result, { reverted: 0, skipped: 1, errors: [] });
});

test("changes with no target are skipped for every target-bound kind", async () => {
  const runId = await createRun();
  for (const kind of [
    "topic_merge",
    "topic_new",
    "persona_addendum",
    "wake_link",
    "skill_author",
  ]) {
    await addChange(runId, kind, { targetId: null });
  }
  const result = await rollbackRun(runId);
  assert.deepEqual(result, { reverted: 0, skipped: 5, errors: [] });
});

test("rollbackRun reverts every change in the run, skipping ones already undone", async () => {
  const keepId = await insertFact({});
  const retired = await insertFact({ active: false, supersededBy: keepId });
  const topicId = await insertTopic({});
  const runId = await createRun();
  await addChange(runId, "fact_resolve", {
    before: { retireIds: [retired], keepId },
  });
  await addChange(runId, "topic_new", { targetId: String(topicId) });
  await addChange(runId, "topic_new", {
    targetId: String(topicId),
    reverted: true, // simulates an earlier partial rollback
  });

  const result = await rollbackRun(runId);
  assert.deepEqual(result, { reverted: 2, skipped: 1, errors: [] });

  const [fact] = await db
    .select()
    .from(userFacts)
    .where(eq(userFacts.id, retired));
  assert.equal(fact?.active, true);
  const [topic] = await db
    .select()
    .from(topicKnowledge)
    .where(eq(topicKnowledge.id, topicId));
  assert.equal(topic?.active, false);
});

test("rollbackRun on a run with no changes does nothing", async () => {
  const runId = await createRun();
  const result = await rollbackRun(runId);
  assert.deepEqual(result, { reverted: 0, skipped: 0, errors: [] });
});

test("a revert that throws a non-Error still yields a readable message", async () => {
  const runId = await createRun();
  const changeId = await addChange(runId, "wake_link", { targetId: "1" });

  const realDelete = db.delete;
  (db as { delete: unknown }).delete = () => {
    throw "database is on fire";
  };
  let result: Awaited<ReturnType<typeof rollbackChange>>;
  try {
    result = await rollbackChange(changeId);
  } finally {
    (db as { delete: unknown }).delete = realDelete;
  }

  assert.equal(result.reverted, 0);
  assert.deepEqual(result.errors, [`change ${changeId}: database is on fire`]);
});

test("a change whose revert throws is reported, not fatal", async () => {
  const runId = await createRun();
  // keepId is not an integer, so the superseded_by comparison blows up in SQL
  const badChange = await addChange(runId, "fact_resolve", {
    before: { retireIds: [1], keepId: "not-a-number" },
  });
  const topicId = await insertTopic({});
  await addChange(runId, "topic_new", { targetId: String(topicId) });

  const result = await rollbackRun(runId);
  assert.equal(result.reverted, 1); // the healthy change still lands
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0] ?? "", new RegExp(`^change ${badChange}: `));
  assert.equal((await changeRow(badChange)).reverted, false);
});
