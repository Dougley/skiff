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

// Smaller clusters keep the fixtures readable: two similar embeddings form a
// cluster, and two clusters per run is enough to exercise the cap.
bootstrapTestEnv({
  LLM_MAX_RETRIES: "0",
  SLEEP_MIN_CLUSTER_SIZE: "2",
  SLEEP_MAX_CLUSTERS_PER_RUN: "2",
});

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
let phase: typeof import("../../../../src/autonomous/sleep/phases/synthesize-topics.js");
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

async function seedEmbedding(params: {
  content: string;
  embedding: number[];
  guildId?: string | null;
  channelId?: string | null;
}) {
  const [row] = await dbm.db
    .insert(dbm.messageEmbeddings)
    .values({
      content: params.content,
      embedding: params.embedding,
      guildId: params.guildId ?? null,
      channelId: params.channelId ?? null,
    })
    .returning();
  assert.ok(row);
  return row;
}

/** Seed `count` embeddings that all cluster together on the given axis. */
async function seedCluster(
  label: string,
  axis: number,
  count: number,
  scope: { guildId?: string | null; channelId?: string | null } = {}
) {
  const embedding = vec(...new Array(axis).fill(0), 1);
  for (let i = 0; i < count; i++) {
    await seedEmbedding({
      content: `${label} message ${i}`,
      embedding,
      ...scope,
    });
  }
  return embedding;
}

async function seedTopic(params: {
  title: string;
  guildId?: string | null;
  channelId?: string | null;
  embedding?: number[] | null;
}) {
  const [row] = await dbm.db
    .insert(dbm.topicKnowledge)
    .values({
      title: params.title,
      summary: "existing summary",
      guildId: params.guildId ?? null,
      channelId: params.channelId ?? null,
      embedding: params.embedding ?? null,
    })
    .returning();
  assert.ok(row);
  return row;
}

async function allTopics() {
  return await dbm.db.select().from(dbm.topicKnowledge);
}

async function newTopicChanges() {
  return await dbm.db
    .select()
    .from(dbm.sleepCycleChanges)
    .where(eq(dbm.sleepCycleChanges.kind, "topic_new"));
}

beforeAll(async () => {
  const { runMigrations } = await import("../../../../src/db/migrate.js");
  await runMigrations();
  dbm = await import("../../../../src/db/index.js");
  envm = await import("../../../../src/config/env.js");
  phase = await import(
    "../../../../src/autonomous/sleep/phases/synthesize-topics.js"
  );
  const [run] = await dbm.db
    .insert(dbm.sleepCycleRuns)
    .values({ guildId: "guild-1", triggerReason: "test" })
    .returning();
  assert.ok(run);
  runId = run.id;
});

// Every test starts from an empty corpus: scope filters overlap (a DM row and
// a legacy row both have guild_id null), so leftovers would skew the counts.
beforeEach(async () => {
  llmQueue.length = 0;
  await dbm.db.delete(dbm.sleepCycleChanges);
  await dbm.db.delete(dbm.messageEmbeddings);
  await dbm.db.delete(dbm.topicKnowledge);
});

test("does nothing when the memory model is disabled", async () => {
  envm.env.MEMORY_EXTRACT_MODEL = "disabled";
  try {
    await seedCluster("disabled", 0, 3, { guildId: "guild-1" });
    const ctx = makeCtx();
    await phase.synthesizeTopics(ctx);
    assert.deepEqual(ctx.phaseStats, {});
    assert.deepEqual(await allTopics(), []);
  } finally {
    envm.env.MEMORY_EXTRACT_MODEL = undefined;
  }
});

test("returns early when there are too few samples to cluster", async () => {
  await seedEmbedding({
    content: "lonely",
    embedding: vec(1),
    guildId: "guild-1",
  });

  const ctx = makeCtx();
  await phase.synthesizeTopics(ctx);

  assert.deepEqual(ctx.phaseStats, {});
});

test("finds no clusters when the samples are mutually dissimilar", async () => {
  await seedEmbedding({ content: "a", embedding: vec(1), guildId: "guild-1" });
  await seedEmbedding({
    content: "b",
    embedding: vec(1, 1),
    guildId: "guild-1",
  });

  const ctx = makeCtx();
  await phase.synthesizeTopics(ctx);

  assert.deepEqual(ctx.phaseStats.synthesize_topics, {
    samplesConsidered: 2,
    clustersFound: 0,
  });
  assert.deepEqual(await allTopics(), []);
});

test("synthesizes a topic from a cluster and records the change", async () => {
  await seedCluster("deploys", 0, 3, { guildId: "guild-1" });

  queueJson({
    title: "Deployment pipeline",
    summary: "The team keeps discussing the deployment pipeline.",
    tags: ["ops", "ci"],
  });

  const ctx = makeCtx();
  await phase.synthesizeTopics(ctx);

  assert.deepEqual(ctx.phaseStats.synthesize_topics, {
    samplesConsidered: 3,
    clustersFound: 1,
    topicsCreated: 1,
  });
  assert.equal(ctx.tokenUsage, TOKENS_PER_CALL);

  const topics = await allTopics();
  assert.equal(topics.length, 1);
  assert.equal(topics[0]?.title, "Deployment pipeline");
  assert.deepEqual(topics[0]?.tags, ["ops", "ci"]);
  assert.equal(topics[0]?.guildId, "guild-1");

  const changes = await newTopicChanges();
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.targetId, String(topics[0]?.id));
  assert.equal(changes[0]?.after?.title, "Deployment pipeline");
  assert.equal((changes[0]?.after?.memberIds as number[]).length, 3);
});

test("skips clusters already covered by an existing topic", async () => {
  const embedding = await seedCluster("known", 0, 3, { guildId: "guild-dup" });
  await seedTopic({ title: "Known subject", guildId: "guild-dup", embedding });

  const ctx = makeCtx({ guildId: "guild-dup" });
  await phase.synthesizeTopics(ctx);

  assert.deepEqual(ctx.phaseStats.synthesize_topics, {
    samplesConsidered: 3,
    clustersFound: 1,
    clustersSkippedDup: 1,
  });
  // no generation was attempted, so nothing was consumed from the queue
  assert.equal(llmQueue.length, 0);
  assert.equal((await allTopics()).length, 1);
});

test("discards a cluster the model reports as topicless (DM scope)", async () => {
  await seedCluster("noise", 0, 2, { channelId: "dm-synth" });

  queueJson({ title: "NO_TOPIC", summary: "unrelated chatter", tags: [] });

  const ctx = makeCtx({ guildId: null, channelId: "dm-synth" });
  await phase.synthesizeTopics(ctx);

  assert.deepEqual(ctx.phaseStats.synthesize_topics, {
    samplesConsidered: 2,
    clustersFound: 1,
    clustersRejected: 1,
  });
  assert.deepEqual(await allTopics(), []);
});

test("skips the cluster when the LLM call fails (legacy scope)", async () => {
  await seedCluster("legacy", 0, 2);

  queueError("provider exploded");

  const ctx = makeCtx({ guildId: null, channelId: null });
  await phase.synthesizeTopics(ctx);

  assert.deepEqual(ctx.phaseStats.synthesize_topics, {
    samplesConsidered: 2,
    clustersFound: 1,
  });
  assert.equal(ctx.tokenUsage, 0);
  assert.deepEqual(await allTopics(), []);
});

test("skips the cluster when the LLM output does not match the schema", async () => {
  await seedCluster("bad-schema", 0, 2, { guildId: "guild-1" });

  queueJson({ summary: "missing a title" });

  const ctx = makeCtx();
  await phase.synthesizeTopics(ctx);

  assert.deepEqual(ctx.phaseStats.synthesize_topics, {
    samplesConsidered: 2,
    clustersFound: 1,
  });
  assert.deepEqual(await allTopics(), []);
});

test("stops after the per-run cluster cap", async () => {
  await seedCluster("first", 0, 2, { guildId: "guild-cap" });
  await seedCluster("second", 5, 2, { guildId: "guild-cap" });
  await seedCluster("third", 9, 2, { guildId: "guild-cap" });

  queueJson({ title: "Topic one", summary: "one", tags: [] });
  queueJson({ title: "Topic two", summary: "two", tags: [] });

  const ctx = makeCtx({ guildId: "guild-cap" });
  await phase.synthesizeTopics(ctx);

  assert.equal(ctx.phaseStats.synthesize_topics?.samplesConsidered, 6);
  assert.equal(ctx.phaseStats.synthesize_topics?.clustersFound, 2);
  assert.equal(ctx.phaseStats.synthesize_topics?.topicsCreated, 2);
  assert.equal((await allTopics()).length, 2);
  // the cap stopped clustering before the third group was ever considered
  assert.equal(llmQueue.length, 0);
});

test("dry run records the proposal without inserting the topic", async () => {
  await seedCluster("dry", 0, 2, { guildId: "guild-dry" });

  queueJson({ title: "Dry topic", summary: "not written", tags: ["x"] });

  const ctx = makeCtx({ guildId: "guild-dry", dryRun: true });
  await phase.synthesizeTopics(ctx);

  assert.deepEqual(ctx.phaseStats.synthesize_topics, {
    samplesConsidered: 2,
    clustersFound: 1,
    topicsCreated: 1,
  });
  assert.deepEqual(await allTopics(), []);

  const changes = await newTopicChanges();
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.targetId, null);
  assert.equal(changes[0]?.after?.title, "Dry topic");
});
