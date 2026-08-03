import assert from "node:assert/strict";
import type { EmbeddingModel } from "ai";
import { MockEmbeddingModelV3 } from "ai/test";
import type { Client } from "discord.js";
import { beforeAll, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

// LLM_MAX_RETRIES=0 so a deliberately failing embed rejects immediately
// instead of backing off through the SDK's retry schedule.
bootstrapTestEnv({ LLM_MAX_RETRIES: "0" });

const providerState = vi.hoisted(() => ({ embedding: null as unknown }));

vi.mock("../../../src/ai/llm/provider.js", () => ({
  get embeddingProvider() {
    return providerState.embedding;
  },
  getEmbeddingProvider: () => providerState.embedding,
  getLLMProvider: () => {
    throw new Error("getLLMProvider must not be called by the topic tools");
  },
  llmProvider: null,
}));

const toolOpts = { toolCallId: "test-call", messages: [] } as never;

let createTopicTools: typeof import("../../../src/ai/tools/topic.js").createTopicTools;
let dbm: typeof import("../../../src/db/index.js");

beforeAll(async () => {
  const [{ runMigrations }, tools, db] = await Promise.all([
    import("../../../src/db/migrate.js"),
    import("../../../src/ai/tools/topic.js"),
    import("../../../src/db/index.js"),
  ]);
  await runMigrations();
  createTopicTools = tools.createTopicTools;
  dbm = db;
});

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    client: {} as Client,
    guildId: null,
    channelId: "topic-channel",
    userId: "topic-user",
    ...overrides,
  } as import("../../../src/ai/tools/discord.js").DiscordToolContext;
}

function unitVector(axis: number): number[] {
  return Array.from({ length: dbm.EMBEDDING_DIMENSIONS }, (_, i) =>
    i === axis ? 1 : 0
  );
}

function mockEmbedding(vector: number[]) {
  return new MockEmbeddingModelV3({
    doEmbed: async () => ({
      embeddings: [vector],
      usage: { tokens: 1 },
      warnings: [],
    }),
  }) as unknown as EmbeddingModel;
}

async function insertTopic(values: Record<string, unknown>) {
  await dbm.db.insert(dbm.topicKnowledge).values({
    title: "Untitled",
    summary: "A summary.",
    tags: [],
    embedding: unitVector(0),
    ...values,
  } as never);
}

async function search(
  toolCtx: ReturnType<typeof ctx>,
  vector = unitVector(0)
): Promise<{
  results: Array<{
    title: string;
    summary: string;
    tags: string[];
    similarity: number;
    createdAt: string | null;
  }>;
  reason?: string;
}> {
  providerState.embedding = mockEmbedding(vector);
  const tools = createTopicTools(toolCtx);
  const result = await tools.topic_search.execute?.(
    { query: "what do we know?" },
    toolOpts
  );
  providerState.embedding = null;
  return result as never;
}

test("topic_search short-circuits on a whitespace-only query", async () => {
  providerState.embedding = mockEmbedding(unitVector(0));
  const tools = createTopicTools(ctx());
  assert.deepEqual(
    await tools.topic_search.execute?.({ query: "  \n " }, toolOpts),
    { results: [], reason: "empty_query" }
  );
  providerState.embedding = null;
});

test("topic_search reports the provider being off rather than failing", async () => {
  providerState.embedding = null;
  const tools = createTopicTools(ctx());
  assert.deepEqual(
    await tools.topic_search.execute?.({ query: "anything" }, toolOpts),
    { results: [], reason: "embedding_disabled" }
  );
});

test("a guild sees its own topics and nothing from DMs or other guilds", async () => {
  await insertTopic({
    guildId: "topic-guild-a",
    channelId: "some-channel",
    title: "Guild A deploy runbook",
    summary: "How guild A ships.",
    tags: ["ops"],
  });
  await insertTopic({
    guildId: "topic-guild-b",
    channelId: null,
    title: "Guild B secrets",
    summary: "Not for A.",
  });
  await insertTopic({
    guildId: null,
    channelId: null,
    title: "Legacy global note",
    summary: "Pre-scoping knowledge.",
  });

  const result = await search(ctx({ guildId: "topic-guild-a" }));
  assert.equal(result.reason, undefined);
  assert.deepEqual(
    result.results.map((r) => r.title),
    ["Guild A deploy runbook"]
  );
  const hit = result.results[0];
  assert.equal(hit?.summary, "How guild A ships.");
  assert.deepEqual(hit?.tags, ["ops"]);
  assert.ok(Math.abs((hit?.similarity ?? 0) - 1) < 1e-6);
  assert.equal(typeof hit?.createdAt, "string");
});

test("a DM sees its own channel's topics plus legacy globals, never a guild's", async () => {
  await insertTopic({
    guildId: null,
    channelId: "dm-alpha",
    title: "Alpha DM topic",
    summary: "Private to alpha.",
  });
  await insertTopic({
    guildId: null,
    channelId: "dm-beta",
    title: "Beta DM topic",
    summary: "Private to beta.",
  });
  await insertTopic({
    guildId: null,
    channelId: null,
    title: "Shared legacy topic",
    summary: "Visible from every DM.",
  });
  await insertTopic({
    guildId: "topic-guild-c",
    channelId: "guild-channel-c",
    title: "Guild C topic",
    summary: "Guild knowledge never leaks into DMs.",
  });

  const result = await search(ctx({ guildId: null, channelId: "dm-alpha" }));
  const titles = result.results.map((r) => r.title);
  assert.ok(titles.includes("Alpha DM topic"));
  assert.ok(titles.includes("Shared legacy topic"));
  assert.ok(!titles.includes("Beta DM topic"));
  assert.ok(!titles.includes("Guild C topic"));
});

test("a DM's channel clause matches on channel id alone", async () => {
  // Documents the filter as written: with no guild in context the channel
  // clause is `channel_id = ?` with no `guild_id is null` companion, so a
  // guild-scoped row sharing the channel id would be in scope. Discord ids
  // are globally unique, so nothing can actually occupy both — this pins the
  // behaviour rather than endorsing it.
  await insertTopic({
    guildId: "topic-guild-shadow",
    channelId: "shadow-channel",
    title: "Shadowed guild topic",
    summary: "Same channel id, different scope.",
  });

  const result = await search(
    ctx({ guildId: null, channelId: "shadow-channel" })
  );
  assert.ok(result.results.some((r) => r.title === "Shadowed guild topic"));
});

test("with no guild and no channel only legacy globals are in scope", async () => {
  await insertTopic({
    guildId: null,
    channelId: "dm-gamma",
    title: "Gamma DM topic",
    summary: "Should stay out.",
  });
  await insertTopic({
    guildId: null,
    channelId: null,
    title: "Rootless legacy topic",
    summary: "The only thing in scope.",
  });

  const result = await search(ctx({ guildId: null, channelId: null }));
  assert.ok(result.results.every((r) => r.title !== "Gamma DM topic"));
  assert.ok(result.results.some((r) => r.title === "Rootless legacy topic"));
});

test("inactive topics, missing embeddings and distant matches are excluded", async () => {
  await insertTopic({
    guildId: "topic-guild-filter",
    title: "Superseded topic",
    summary: "Merged into another.",
    active: false,
  });
  await insertTopic({
    guildId: "topic-guild-filter",
    title: "Never embedded",
    summary: "No vector to compare.",
    embedding: null,
  });
  await insertTopic({
    guildId: "topic-guild-filter",
    title: "Unrelated topic",
    summary: "Orthogonal to the query.",
    embedding: unitVector(3),
  });
  await insertTopic({
    guildId: "topic-guild-filter",
    title: "The match",
    summary: "Right on the query axis.",
  });

  const result = await search(ctx({ guildId: "topic-guild-filter" }));
  assert.deepEqual(
    result.results.map((r) => r.title),
    ["The match"]
  );
});

test("results are capped at RAG_TOP_K, nearest first", async () => {
  const { env } = await import("../../../src/config/env.js");
  // near-identical vectors, each slightly further from the query axis
  for (let i = 0; i < env.RAG_TOP_K + 3; i++) {
    const embedding = unitVector(0);
    embedding[5] = 0.01 * (i + 1);
    await insertTopic({
      guildId: "topic-guild-topk",
      title: `Topic ${i}`,
      summary: `Summary ${i}`,
      embedding,
    });
  }

  const result = await search(ctx({ guildId: "topic-guild-topk" }));
  assert.equal(result.results.length, env.RAG_TOP_K);
  const similarities = result.results.map((r) => r.similarity);
  assert.deepEqual(
    similarities,
    [...similarities].sort((a, b) => b - a)
  );
  assert.equal(result.results[0]?.title, "Topic 0");
});

test("topic_search degrades to a reason when the embedding call fails", async () => {
  providerState.embedding = new MockEmbeddingModelV3({
    doEmbed: async () => {
      throw new Error("embedding service down");
    },
  }) as unknown as EmbeddingModel;

  const tools = createTopicTools(ctx());
  assert.deepEqual(
    await tools.topic_search.execute?.({ query: "anything" }, toolOpts),
    { results: [], reason: "embedding_failed" }
  );
  providerState.embedding = null;
});

test("topic_search degrades to a reason when the query fails", async () => {
  providerState.embedding = mockEmbedding(unitVector(0));
  const spy = vi.spyOn(dbm.db, "select").mockImplementationOnce(() => {
    throw new Error("connection terminated");
  });

  const tools = createTopicTools(ctx());
  assert.deepEqual(
    await tools.topic_search.execute?.({ query: "anything" }, toolOpts),
    { results: [], reason: "db_error" }
  );

  spy.mockRestore();
  providerState.embedding = null;
});
