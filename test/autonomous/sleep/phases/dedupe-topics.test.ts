import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../../helpers/setup.js";
import {
  llmQueue,
  queueError,
  queueJson,
  TOKENS_PER_CALL,
  vec,
} from "./llm-mock.js";

bootstrapTestEnv({ LLM_MAX_RETRIES: "0" });

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
let phase: typeof import("../../../../src/autonomous/sleep/phases/dedupe-topics.js");
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
    now: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

async function seedTopic(params: {
  title: string;
  summary: string;
  guildId?: string | null;
  channelId?: string | null;
  tags?: string[];
  embedding?: number[] | null;
}) {
  const [row] = await dbm.db
    .insert(dbm.topicKnowledge)
    .values({
      title: params.title,
      summary: params.summary,
      tags: params.tags ?? [],
      guildId: params.guildId ?? null,
      channelId: params.channelId ?? null,
      embedding: params.embedding === undefined ? vec(1) : params.embedding,
    })
    .returning();
  assert.ok(row);
  return row;
}

async function topicById(id: number) {
  const [row] = await dbm.db
    .select()
    .from(dbm.topicKnowledge)
    .where(eq(dbm.topicKnowledge.id, id));
  assert.ok(row);
  return row;
}

async function changesForRun(kind: string) {
  return await dbm.db
    .select()
    .from(dbm.sleepCycleChanges)
    .where(eq(dbm.sleepCycleChanges.kind, kind));
}

beforeAll(async () => {
  const { runMigrations } = await import("../../../../src/db/migrate.js");
  await runMigrations();
  dbm = await import("../../../../src/db/index.js");
  envm = await import("../../../../src/config/env.js");
  phase = await import(
    "../../../../src/autonomous/sleep/phases/dedupe-topics.js"
  );
  const [run] = await dbm.db
    .insert(dbm.sleepCycleRuns)
    .values({ guildId: "guild-1", triggerReason: "test" })
    .returning();
  assert.ok(run);
  runId = run.id;
});

beforeEach(() => {
  llmQueue.length = 0;
});

test("does nothing when the memory model is disabled", async () => {
  envm.env.MEMORY_EXTRACT_MODEL = "disabled";
  try {
    await seedTopic({ title: "a", summary: "a", guildId: "g-disabled" });
    await seedTopic({ title: "b", summary: "b", guildId: "g-disabled" });
    const ctx = makeCtx({ guildId: "g-disabled" });
    await phase.dedupeTopics(ctx);
    assert.deepEqual(ctx.phaseStats, {});
  } finally {
    envm.env.MEMORY_EXTRACT_MODEL = undefined;
  }
});

test("returns early when the scope has fewer than two embedded topics", async () => {
  await seedTopic({ title: "lonely", summary: "only one", guildId: "g-solo" });
  // a second topic without an embedding is filtered out by the query
  await seedTopic({
    title: "no vector",
    summary: "unusable",
    guildId: "g-solo",
    embedding: null,
  });

  const ctx = makeCtx({ guildId: "g-solo" });
  await phase.dedupeTopics(ctx);

  assert.deepEqual(ctx.phaseStats, {});
});

test("leaves dissimilar topics alone without calling the LLM", async () => {
  const a = await seedTopic({
    title: "Deployment",
    summary: "How we deploy",
    guildId: "g-far",
    embedding: vec(1),
  });
  const b = await seedTopic({
    title: "Lunch",
    summary: "Where we eat",
    guildId: "g-far",
    embedding: vec(1, 1),
  });

  const ctx = makeCtx({ guildId: "g-far" });
  await phase.dedupeTopics(ctx);

  // cosine here is ~0.71, well under the 0.9 merge threshold
  assert.deepEqual(ctx.phaseStats.dedupe_topics, { topicsScanned: 2 });
  assert.equal((await topicById(a.id)).active, true);
  assert.equal((await topicById(b.id)).active, true);
  assert.equal(llmQueue.length, 0);
});

test("merges near-duplicate topics into the canonical entry", async () => {
  const a = await seedTopic({
    title: "PGlite storage",
    summary: "We use PGlite for local storage.",
    guildId: "g-merge",
    tags: ["db"],
    embedding: vec(1),
  });
  const b = await seedTopic({
    title: "pglite",
    summary: "Storage runs on PGlite.",
    guildId: "g-merge",
    tags: ["storage"],
    embedding: vec(1, 0.2),
  });

  queueJson({
    canonicalId: a.id,
    mergedSummary: "Storage runs on PGlite, embedded in the process.",
    mergedTags: ["db", "storage"],
  });

  const ctx = makeCtx({ guildId: "g-merge" });
  await phase.dedupeTopics(ctx);

  assert.deepEqual(ctx.phaseStats.dedupe_topics, {
    topicsScanned: 2,
    merges: 1,
  });
  assert.equal(ctx.tokenUsage, TOKENS_PER_CALL);

  const canonical = await topicById(a.id);
  assert.equal(canonical.active, true);
  assert.equal(
    canonical.summary,
    "Storage runs on PGlite, embedded in the process."
  );
  assert.deepEqual(canonical.tags, ["db", "storage"]);

  const loser = await topicById(b.id);
  assert.equal(loser.active, false);
  assert.equal(loser.supersededBy, a.id);

  const changes = (await changesForRun("topic_merge")).filter(
    (c) => c.targetId === String(a.id)
  );
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0]?.after, {
    mergedSummary: "Storage runs on PGlite, embedded in the process.",
    mergedTags: ["db", "storage"],
  });
});

test("keeps the canonical tags when the merge returns none, and stops pairing a retired topic (DM scope)", async () => {
  const a = await seedTopic({
    title: "weak title",
    summary: "first",
    channelId: "dm-merge",
    tags: ["keep-me"],
    embedding: vec(1),
  });
  const b = await seedTopic({
    title: "Stronger Title",
    summary: "second",
    channelId: "dm-merge",
    tags: ["canonical-tag"],
    embedding: vec(1, 0.2),
  });
  // C is a near-duplicate of A (cos ~0.94) but not of B (cos ~0.86), so it is
  // only reachable if the loop keeps pairing A after A has been retired
  const c = await seedTopic({
    title: "similar to the loser only",
    summary: "third",
    channelId: "dm-merge",
    embedding: vec(1, -0.36),
  });

  // canonical is B, so A (the outer-loop topic) is retired and pairing stops
  queueJson({
    canonicalId: b.id,
    mergedSummary: "combined summary",
    mergedTags: [],
  });
  // a second result that must go unused
  queueJson({
    canonicalId: c.id,
    mergedSummary: "should never be applied",
    mergedTags: [],
  });

  const ctx = makeCtx({ guildId: null, channelId: "dm-merge" });
  await phase.dedupeTopics(ctx);

  assert.deepEqual(ctx.phaseStats.dedupe_topics, {
    topicsScanned: 3,
    merges: 1,
  });

  const canonical = await topicById(b.id);
  assert.equal(canonical.summary, "combined summary");
  assert.deepEqual(canonical.tags, ["canonical-tag"]);
  assert.equal((await topicById(a.id)).active, false);
  assert.equal((await topicById(a.id)).supersededBy, b.id);
  assert.equal((await topicById(c.id)).active, true);
  assert.equal((await topicById(c.id)).summary, "third");
  // exactly one generation happened — the second canned result went unused
  assert.equal(llmQueue.length, 1);
});

test("skips a merge whose canonical id matches neither topic", async () => {
  const a = await seedTopic({
    title: "alpha",
    summary: "alpha",
    guildId: "g-unknown",
    embedding: vec(1),
  });
  const b = await seedTopic({
    title: "beta",
    summary: "beta",
    guildId: "g-unknown",
    embedding: vec(1, 0.2),
  });

  queueJson({
    canonicalId: 987654,
    mergedSummary: "merged",
    mergedTags: [],
  });

  const ctx = makeCtx({ guildId: "g-unknown" });
  await phase.dedupeTopics(ctx);

  assert.deepEqual(ctx.phaseStats.dedupe_topics, { topicsScanned: 2 });
  assert.equal((await topicById(a.id)).active, true);
  assert.equal((await topicById(b.id)).active, true);
});

test("skips the pair when the LLM call throws", async () => {
  const a = await seedTopic({
    title: "one",
    summary: "one",
    guildId: "g-err",
    embedding: vec(1),
  });
  const b = await seedTopic({
    title: "two",
    summary: "two",
    guildId: "g-err",
    embedding: vec(1, 0.2),
  });

  queueError("provider exploded");

  const ctx = makeCtx({ guildId: "g-err" });
  await phase.dedupeTopics(ctx);

  assert.deepEqual(ctx.phaseStats.dedupe_topics, { topicsScanned: 2 });
  assert.equal(ctx.tokenUsage, 0);
  assert.equal((await topicById(a.id)).active, true);
  assert.equal((await topicById(b.id)).active, true);
});

test("skips the pair when the LLM output does not match the schema", async () => {
  const a = await seedTopic({
    title: "one",
    summary: "one",
    guildId: "g-badschema",
    embedding: vec(1),
  });
  const b = await seedTopic({
    title: "two",
    summary: "two",
    guildId: "g-badschema",
    embedding: vec(1, 0.2),
  });

  // mergedSummary is required — the structured-output parse must reject this
  queueJson({ canonicalId: a.id });

  const ctx = makeCtx({ guildId: "g-badschema" });
  await phase.dedupeTopics(ctx);

  assert.deepEqual(ctx.phaseStats.dedupe_topics, { topicsScanned: 2 });
  assert.equal((await topicById(a.id)).active, true);
  assert.equal((await topicById(b.id)).active, true);
});

test("dry run logs the merge without touching the topics (legacy scope)", async () => {
  const a = await seedTopic({
    title: "legacy a",
    summary: "legacy a",
    embedding: vec(1),
  });
  const b = await seedTopic({
    title: "legacy b",
    summary: "legacy b",
    embedding: vec(1, 0.2),
  });

  queueJson({
    canonicalId: a.id,
    mergedSummary: "would be merged",
    mergedTags: ["x"],
  });

  const ctx = makeCtx({ guildId: null, channelId: null, dryRun: true });
  await phase.dedupeTopics(ctx);

  assert.deepEqual(ctx.phaseStats.dedupe_topics, {
    topicsScanned: 2,
    merges: 1,
  });
  assert.equal((await topicById(a.id)).summary, "legacy a");
  assert.equal((await topicById(b.id)).active, true);
  assert.equal((await topicById(b.id)).supersededBy, null);

  const changes = (await changesForRun("topic_merge")).filter(
    (c) => c.targetId === String(a.id)
  );
  assert.equal(changes.length, 1);
});
