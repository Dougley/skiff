import assert from "node:assert/strict";
import type { EmbeddingModel } from "ai";
import { MockEmbeddingModelV3 } from "ai/test";
import { and, eq } from "drizzle-orm";
import { beforeAll, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

// swap the embedding provider per test: null = disabled, a mock = enabled.
// the getter keeps the module-level `embeddingProvider` binding live.
const providerState = vi.hoisted(() => ({
  embedding: null as unknown,
}));

vi.mock("../../../src/ai/llm/provider.js", () => ({
  get embeddingProvider() {
    return providerState.embedding;
  },
  getEmbeddingProvider: () => providerState.embedding,
  getLLMProvider: () => {
    throw new Error("getLLMProvider must not be called by the memory store");
  },
  llmProvider: null,
}));

let store: typeof import("../../../src/ai/memory/store.js");
let dbm: typeof import("../../../src/db/index.js");

beforeAll(async () => {
  const [{ runMigrations }, storeModule, dbModule] = await Promise.all([
    import("../../../src/db/migrate.js"),
    import("../../../src/ai/memory/store.js"),
    import("../../../src/db/index.js"),
  ]);
  await runMigrations();
  store = storeModule;
  dbm = dbModule;
});

async function factRows(userId: string) {
  return dbm.db
    .select()
    .from(dbm.userFacts)
    .where(eq(dbm.userFacts.userId, userId));
}

test("upserting an empty fact list is a no-op", async () => {
  assert.equal(
    await store.upsertUserFacts({ userId: "u-empty", facts: [] }),
    0
  );
  assert.equal((await factRows("u-empty")).length, 0);
});

test("a local fact in a guild scopes to the guild with sane defaults", async () => {
  const count = await store.upsertUserFacts({
    userId: "u-guild",
    guildId: "g1",
    channelId: "c1",
    facts: [{ fact: "keeps bees" }],
  });
  assert.equal(count, 1);

  const [row] = await factRows("u-guild");
  assert.ok(row);
  assert.equal(row.guildId, "g1");
  assert.equal(row.channelId, null); // guild wins over channel for local facts
  assert.equal(row.confidence, 80); // default confidence
  assert.equal(row.category, null);
  assert.equal(row.active, true);
});

test("a global fact carries neither guild nor channel", async () => {
  await store.upsertUserFacts({
    userId: "u-global",
    guildId: "g1",
    channelId: "c1",
    facts: [{ fact: "uses she/her pronouns", scope: "global" }],
  });
  const [row] = await factRows("u-global");
  assert.ok(row);
  assert.equal(row.guildId, null);
  assert.equal(row.channelId, null);
});

test("a local fact in a DM scopes to the channel", async () => {
  await store.upsertUserFacts({
    userId: "u-dm",
    guildId: null,
    channelId: "dm-7",
    facts: [{ fact: "planning a surprise party", category: "context" }],
  });
  const [row] = await factRows("u-dm");
  assert.ok(row);
  assert.equal(row.guildId, null);
  assert.equal(row.channelId, "dm-7");
  assert.equal(row.category, "context");
});

test("restating a fact supersedes the old row without erasing it", async () => {
  await store.upsertUserFacts({
    userId: "u-supersede",
    guildId: "g1",
    facts: [{ fact: "Drinks Oat Milk  " }],
  });
  await store.upsertUserFacts({
    userId: "u-supersede",
    guildId: "g1",
    facts: [{ fact: "drinks oat milk" }],
  });

  const rows = await factRows("u-supersede");
  assert.equal(rows.length, 2);
  const old = rows.find((r) => r.fact === "Drinks Oat Milk  ");
  const fresh = rows.find((r) => r.fact === "drinks oat milk");
  assert.ok(old && fresh);
  assert.equal(old.active, false);
  assert.equal(old.supersededBy, fresh.id);
  assert.equal(fresh.active, true);
});

test("the same fact text in another scope does not supersede", async () => {
  await store.upsertUserFacts({
    userId: "u-scopes",
    guildId: "g1",
    facts: [{ fact: "likes chess" }],
  });
  await store.upsertUserFacts({
    userId: "u-scopes",
    guildId: "g2",
    facts: [{ fact: "likes chess" }],
  });

  const rows = await factRows("u-scopes");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.active));
  assert.ok(rows.every((r) => r.supersededBy === null));
});

test("confidence is clamped to 0-100 and rounded", async () => {
  await store.upsertUserFacts({
    userId: "u-confidence",
    facts: [
      { fact: "too confident", confidence: 150 },
      { fact: "negative confidence", confidence: -20 },
      { fact: "fractional confidence", confidence: 55.4 },
    ],
  });
  const rows = await factRows("u-confidence");
  const byFact = new Map(rows.map((r) => [r.fact, r.confidence]));
  assert.equal(byFact.get("too confident"), 100);
  assert.equal(byFact.get("negative confidence"), 0);
  assert.equal(byFact.get("fractional confidence"), 55);
});

test("a guild topic summary scopes to the guild without an embedding when disabled", async () => {
  providerState.embedding = null;
  const inserted = await store.insertTopicSummary({
    guildId: "g-topic",
    channelId: "ignored-channel",
    createdByUserId: "author",
    summary: {
      title: "Release plan",
      summary: "Ship on Friday.",
      tags: ["release"],
    },
  });
  assert.ok(inserted);

  const [row] = await dbm.db
    .select()
    .from(dbm.topicKnowledge)
    .where(eq(dbm.topicKnowledge.id, inserted.id));
  assert.ok(row);
  assert.equal(row.guildId, "g-topic");
  assert.equal(row.channelId, null);
  assert.equal(row.createdByUserId, "author");
  assert.equal(row.embedding, null);
  assert.deepEqual(row.tags, ["release"]);
  assert.equal(row.active, true);
});

test("a DM topic summary scopes to the channel", async () => {
  providerState.embedding = null;
  const inserted = await store.insertTopicSummary({
    guildId: null,
    channelId: "dm-topic",
    summary: { title: "Gift ideas", summary: "A telescope.", tags: [] },
  });
  assert.ok(inserted);

  const [row] = await dbm.db
    .select()
    .from(dbm.topicKnowledge)
    .where(eq(dbm.topicKnowledge.id, inserted.id));
  assert.ok(row);
  assert.equal(row.guildId, null);
  assert.equal(row.channelId, "dm-topic");
});

test("with an embedding provider the topic gets a normalized embedding", async () => {
  const mock = new MockEmbeddingModelV3({
    doEmbed: async () => ({
      embeddings: [[0.1, 0.2, 0.3]],
      usage: { tokens: 3 },
      warnings: [],
    }),
  });
  providerState.embedding = mock as unknown as EmbeddingModel;

  const inserted = await store.insertTopicSummary({
    guildId: "g-embed",
    summary: { title: "Vector search", summary: "How recall works.", tags: [] },
  });
  assert.ok(inserted);
  assert.equal(mock.doEmbedCalls.length, 1);

  const [row] = await dbm.db
    .select()
    .from(dbm.topicKnowledge)
    .where(eq(dbm.topicKnowledge.id, inserted.id));
  assert.ok(row?.embedding);
  assert.equal(row.embedding.length, dbm.EMBEDDING_DIMENSIONS);
  assert.ok(Math.abs((row.embedding[0] ?? 0) - 0.1) < 1e-6);
  providerState.embedding = null;
});

test("a failing embedding call does not block the topic insert", async () => {
  providerState.embedding = new MockEmbeddingModelV3({
    doEmbed: async () => {
      throw new Error("embedding service down");
    },
  }) as unknown as EmbeddingModel;

  const inserted = await store.insertTopicSummary({
    guildId: "g-embed-fail",
    summary: { title: "Resilience", summary: "Still stored.", tags: [] },
  });
  assert.ok(inserted);

  const [row] = await dbm.db
    .select()
    .from(dbm.topicKnowledge)
    .where(eq(dbm.topicKnowledge.id, inserted.id));
  assert.ok(row);
  assert.equal(row.embedding, null);
  providerState.embedding = null;
});

test("storeExtraction writes facts and the topic in one pass", async () => {
  const [conversation] = await dbm.db
    .insert(dbm.conversations)
    .values({ channelId: "extraction-channel", guildId: "g-x", model: "test" })
    .returning();
  assert.ok(conversation);

  await store.storeExtraction({
    userId: "u-extraction",
    guildId: "g-x",
    channelId: "extraction-channel",
    sourceConversationId: conversation.id,
    extraction: {
      userFacts: [{ fact: "maintains the build server", scope: "local" }],
      topicSummary: {
        title: "CI outage",
        summary: "Root cause was disk space.",
        tags: ["ci"],
      },
    },
  });

  const facts = await factRows("u-extraction");
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.guildId, "g-x");

  const topics = await dbm.db
    .select()
    .from(dbm.topicKnowledge)
    .where(
      and(
        eq(dbm.topicKnowledge.guildId, "g-x"),
        eq(dbm.topicKnowledge.title, "CI outage")
      )
    );
  assert.equal(topics.length, 1);
  assert.equal(topics[0]?.sourceConversationId, conversation.id);
  assert.equal(topics[0]?.createdByUserId, "u-extraction");
});

test("storeExtraction without a user drops facts but keeps the topic", async () => {
  const before = (await dbm.db.select().from(dbm.userFacts)).length;

  await store.storeExtraction({
    userId: null,
    guildId: "g-anon",
    extraction: {
      userFacts: [{ fact: "should never be stored" }],
      topicSummary: { title: "Anon topic", summary: "No author.", tags: [] },
    },
  });

  assert.equal((await dbm.db.select().from(dbm.userFacts)).length, before);
  const topics = await dbm.db
    .select()
    .from(dbm.topicKnowledge)
    .where(eq(dbm.topicKnowledge.guildId, "g-anon"));
  assert.equal(topics.length, 1);
  assert.equal(topics[0]?.createdByUserId, null);
});

test("storeExtraction without a topic stores only facts", async () => {
  const topicsBefore = (await dbm.db.select().from(dbm.topicKnowledge)).length;
  await store.storeExtraction({
    userId: "u-facts-only",
    extraction: { userFacts: [{ fact: "prefers dark mode" }] },
  });
  assert.equal(
    (await dbm.db.select().from(dbm.topicKnowledge)).length,
    topicsBefore
  );
  assert.equal((await factRows("u-facts-only")).length, 1);
});
