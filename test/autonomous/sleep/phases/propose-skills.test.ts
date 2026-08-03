import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../../helpers/setup.js";
import {
  llmQueue,
  queueError,
  queueJson,
  TOKENS_PER_CALL,
} from "./llm-mock.js";

const skillsRoot = mkdtempSync(join(tmpdir(), "skiff-propose-skills-"));

bootstrapTestEnv({ LLM_MAX_RETRIES: "0", SKILLS_DIR: skillsRoot });

vi.mock("../../../../src/ai/llm/provider.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/ai/llm/provider.js")>();
  const { MockLanguageModelV3 } = await import("ai/test");
  const { llmQueue: queue } = await import("./llm-mock.js");
  return {
    ...actual,
    getLLMProvider: () =>
      new MockLanguageModelV3({
        doGenerate: async () => {
          const next = queue.shift();
          if (next === undefined) throw new Error("llm mock queue is empty");
          if (next instanceof Error) throw next;
          return next;
        },
      }),
  };
});

import type { DreamContext } from "../../../../src/autonomous/sleep/context.js";

let dbm: typeof import("../../../../src/db/index.js");
let phase: typeof import("../../../../src/autonomous/sleep/phases/propose-skills.js");
let skills: typeof import("../../../../src/ai/skills/index.js");
let envm: typeof import("../../../../src/config/env.js");
let runId: number;

function makeCtx(overrides: Partial<DreamContext> = {}): DreamContext {
  return {
    runId,
    guildId: "guild-1",
    channelId: null,
    dryRun: false,
    phaseStats: {},
    tokenUsage: 0,
    now: new Date(),
    ...overrides,
  };
}

function proposal(
  slug: string,
  confidence: number,
  overrides: Record<string, unknown> = {}
) {
  return {
    slug,
    title: `Handle ${slug}`,
    description: `Recurring ${slug} requests`,
    body: `## Approach\n\nWhen a user asks about ${slug}, gather the context first and answer with the shortest correct fix.`,
    confidence,
    ...overrides,
  };
}

/** Seed a conversation with `count` user messages in the given scope. */
async function seedUserMessages(
  channelId: string,
  guildId: string | null,
  count: number
) {
  const [conversation] = await dbm.db
    .insert(dbm.conversations)
    .values({ channelId, guildId, model: "test" })
    .returning();
  assert.ok(conversation);
  for (let i = 0; i < count; i++) {
    await dbm.db.insert(dbm.messages).values({
      conversationId: conversation.id,
      role: "user",
      content: `please summarize the release notes (${i})`,
      userId: "user-1",
    });
  }
  return conversation;
}

async function authoredDirs() {
  return (await readdir(skillsRoot)).sort();
}

async function skillChanges() {
  return await dbm.db
    .select()
    .from(dbm.sleepCycleChanges)
    .where(eq(dbm.sleepCycleChanges.kind, "skill_author"))
    .orderBy(dbm.sleepCycleChanges.id);
}

beforeAll(async () => {
  const { runMigrations } = await import("../../../../src/db/migrate.js");
  await runMigrations();
  dbm = await import("../../../../src/db/index.js");
  envm = await import("../../../../src/config/env.js");
  skills = await import("../../../../src/ai/skills/index.js");
  phase = await import(
    "../../../../src/autonomous/sleep/phases/propose-skills.js"
  );
  const [run] = await dbm.db
    .insert(dbm.sleepCycleRuns)
    .values({ guildId: "guild-1", triggerReason: "test" })
    .returning();
  assert.ok(run);
  runId = run.id;
});

afterAll(() => {
  rmSync(skillsRoot, { recursive: true, force: true });
});

// The skills cache and the skills directory are both process-global, so each
// test starts from an empty directory and an empty cache.
beforeEach(async () => {
  llmQueue.length = 0;
  rmSync(skillsRoot, { recursive: true, force: true });
  await mkdir(skillsRoot, { recursive: true });
  await skills.initSkills(skillsRoot);
  await dbm.db.delete(dbm.sleepCycleChanges);
  await dbm.db.delete(dbm.messages);
  await dbm.db.delete(dbm.conversations);
});

test("does nothing when the memory model is disabled", async () => {
  envm.env.MEMORY_EXTRACT_MODEL = "disabled";
  try {
    await seedUserMessages("chan-disabled", "guild-1", 20);
    const ctx = makeCtx();
    await phase.proposeSkills(ctx);
    assert.deepEqual(ctx.phaseStats, {});
    assert.deepEqual(await authoredDirs(), []);
  } finally {
    envm.env.MEMORY_EXTRACT_MODEL = undefined;
  }
});

test("skips scopes without enough recent user messages (legacy scope)", async () => {
  await seedUserMessages("legacy-chan", null, 19);

  const ctx = makeCtx({ guildId: null, channelId: null });
  await phase.proposeSkills(ctx);

  assert.deepEqual(ctx.phaseStats.propose_skills, { skippedLowSignal: 1 });
  assert.equal(llmQueue.length, 0);
});

test("authors the qualifying proposals and reloads the skill cache", async () => {
  await seedUserMessages("chan-author", "guild-author", 21);

  queueJson({
    proposals: [
      proposal("release-notes", 90),
      proposal("changelog-diff", 80),
      // dropped by the two-proposal cap
      proposal("third-idea", 99),
    ],
  });

  const ctx = makeCtx({ guildId: "guild-author" });
  await phase.proposeSkills(ctx);

  assert.deepEqual(ctx.phaseStats.propose_skills, {
    messagesConsidered: 21,
    skillsAuthored: 2,
  });
  assert.equal(ctx.tokenUsage, TOKENS_PER_CALL);

  assert.deepEqual(await authoredDirs(), [
    `auto-changelog-diff-${runId}`,
    `auto-release-notes-${runId}`,
  ]);

  const written = await readFile(
    join(skillsRoot, `auto-release-notes-${runId}`, "SKILL.md"),
    "utf-8"
  );
  assert.match(written, /^---\n/);
  assert.match(written, /name: auto-release-notes/);
  assert.match(written, /version: 0\.1\.0-run\d+/);
  assert.match(written, /# Handle release-notes/);
  assert.match(written, /auto-authored by sleep cycle run/);

  // the cache was reloaded from disk, so the new skills are visible
  assert.deepEqual(
    skills
      .getAllSkills()
      .map((s) => s.manifest.name)
      .sort(),
    ["auto-changelog-diff", "auto-release-notes"]
  );

  const changes = await skillChanges();
  assert.equal(changes.length, 2);
  assert.equal(changes[0]?.targetTable, "filesystem");
  assert.equal(changes[0]?.after?.name, "auto-release-notes");
  assert.equal(changes[0]?.after?.dryRun, false);
});

test("drops low-confidence, duplicate and already-authored proposals", async () => {
  await seedUserMessages("chan-filter", "guild-filter", 20);

  // an auto-skill that already exists on disk and in the cache
  const existingDir = join(skillsRoot, "auto-taken-1");
  await mkdir(existingDir, { recursive: true });
  writeFileSync(
    join(existingDir, "SKILL.md"),
    "---\nname: auto-taken\ndescription: already here\n---\n# Taken\n"
  );
  await skills.initSkills(skillsRoot);

  queueJson({
    proposals: [
      proposal("too-unsure", 50),
      proposal("taken", 95),
      proposal("repeated", 95),
      proposal("repeated", 96),
    ],
  });

  const ctx = makeCtx({ guildId: "guild-filter" });
  await phase.proposeSkills(ctx);

  // "repeated" survives dedupe once — it is the only qualifying proposal
  assert.deepEqual(ctx.phaseStats.propose_skills, {
    messagesConsidered: 20,
    skillsAuthored: 1,
  });
  assert.deepEqual(await authoredDirs(), [
    `auto-repeated-${runId}`,
    "auto-taken-1",
  ]);
});

test("records no proposals when none clears the confidence bar", async () => {
  await seedUserMessages("chan-weak", "guild-weak", 20);

  queueJson({ proposals: [proposal("meh", 10), proposal("nope", 74)] });

  const ctx = makeCtx({ guildId: "guild-weak" });
  await phase.proposeSkills(ctx);

  assert.deepEqual(ctx.phaseStats.propose_skills, {
    messagesConsidered: 20,
    noQualifying: 1,
  });
  assert.deepEqual(await authoredDirs(), []);
  assert.deepEqual(await skillChanges(), []);
});

test("degrades gracefully when the LLM call fails", async () => {
  await seedUserMessages("chan-err", "guild-err", 20);

  queueError("provider exploded");

  const ctx = makeCtx({ guildId: "guild-err" });
  await phase.proposeSkills(ctx);

  assert.deepEqual(ctx.phaseStats.propose_skills, { messagesConsidered: 20 });
  assert.equal(ctx.tokenUsage, 0);
  assert.deepEqual(await authoredDirs(), []);
});

test("degrades gracefully when the LLM output does not match the schema", async () => {
  await seedUserMessages("chan-badschema", "guild-badschema", 20);

  // slugs must be lowercase/hyphen only
  queueJson({ proposals: [proposal("Not A Slug", 95)] });

  const ctx = makeCtx({ guildId: "guild-badschema" });
  await phase.proposeSkills(ctx);

  assert.deepEqual(ctx.phaseStats.propose_skills, { messagesConsidered: 20 });
  assert.deepEqual(await authoredDirs(), []);
});

test("dry run records the proposal without writing to disk (DM scope)", async () => {
  await seedUserMessages("dm-propose", null, 20);

  queueJson({ proposals: [proposal("dm-helper", 95)] });

  const ctx = makeCtx({ guildId: null, channelId: "dm-propose", dryRun: true });
  await phase.proposeSkills(ctx);

  assert.deepEqual(ctx.phaseStats.propose_skills, {
    messagesConsidered: 20,
    proposalsPending: 1,
  });
  assert.deepEqual(await authoredDirs(), []);

  const changes = await skillChanges();
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.after?.dryRun, true);
  assert.equal(changes[0]?.after?.name, "auto-dm-helper");
  assert.deepEqual(skills.getAllSkills(), []);
});

test("skips a proposal it cannot write to disk", async () => {
  await seedUserMessages("chan-nowrite", "guild-nowrite", 20);

  // point SKILLS_DIR at a regular file so mkdir fails with ENOTDIR
  const blocker = join(skillsRoot, "blocker");
  writeFileSync(blocker, "not a directory");
  envm.env.SKILLS_DIR = join(blocker, "nested");

  try {
    queueJson({ proposals: [proposal("unwritable", 95)] });

    const ctx = makeCtx({ guildId: "guild-nowrite" });
    await phase.proposeSkills(ctx);

    assert.deepEqual(ctx.phaseStats.propose_skills, { messagesConsidered: 20 });
    assert.deepEqual(await skillChanges(), []);
  } finally {
    envm.env.SKILLS_DIR = skillsRoot;
  }
});
