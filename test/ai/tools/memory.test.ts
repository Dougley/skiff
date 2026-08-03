import assert from "node:assert/strict";
import type { EmbeddingModel } from "ai";
import { MockEmbeddingModelV3 } from "ai/test";
import type { Client } from "discord.js";
import { eq } from "drizzle-orm";
import { beforeAll, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

// LLM_MAX_RETRIES=0 so a deliberately failing embed rejects immediately
// instead of backing off through the SDK's retry schedule.
bootstrapTestEnv({ LLM_MAX_RETRIES: "0" });

// swap the embedding provider per test: null = disabled, a mock = enabled.
// the getter keeps the module-level `embeddingProvider` binding live.
const providerState = vi.hoisted(() => ({ embedding: null as unknown }));

vi.mock("../../../src/ai/llm/provider.js", () => ({
  get embeddingProvider() {
    return providerState.embedding;
  },
  getEmbeddingProvider: () => providerState.embedding,
  getLLMProvider: () => {
    throw new Error("getLLMProvider must not be called by the memory tools");
  },
  llmProvider: null,
}));

const toolOpts = { toolCallId: "test-call", messages: [] } as never;

let createMemoryTools: typeof import("../../../src/ai/tools/memory.js").createMemoryTools;
let dbm: typeof import("../../../src/db/index.js");

beforeAll(async () => {
  const [{ runMigrations }, tools, db] = await Promise.all([
    import("../../../src/db/migrate.js"),
    import("../../../src/ai/tools/memory.js"),
    import("../../../src/db/index.js"),
  ]);
  await runMigrations();
  createMemoryTools = tools.createMemoryTools;
  dbm = db;
});

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    client: {} as Client,
    guildId: "mem-guild",
    channelId: "mem-channel",
    userId: "mem-user",
    ...overrides,
  } as import("../../../src/ai/tools/discord.js").DiscordToolContext;
}

/** An embedding pointing along one axis, so similarity is easy to reason about. */
function unitVector(axis: number, dimensions: number): number[] {
  return Array.from({ length: dimensions }, (_, i) => (i === axis ? 1 : 0));
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

// memory_save

test("memory_save persists a fact for the current user", async () => {
  providerState.embedding = null;
  const tools = createMemoryTools(ctx({ userId: "saver-1" }));

  const result = await tools.memory_save.execute?.(
    { fact: "Prefers concise answers", category: "preference", scope: "local" },
    toolOpts
  );
  assert.deepEqual(result, {
    saved: true,
    fact: "Prefers concise answers",
    scope: "local",
  });

  const rows = await dbm.db
    .select()
    .from(dbm.userFacts)
    .where(eq(dbm.userFacts.userId, "saver-1"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.fact, "Prefers concise answers");
  assert.equal(rows[0]?.category, "preference");
  // local scope stays tied to the guild it was learned in
  assert.equal(rows[0]?.guildId, "mem-guild");
});

test("a global fact is not pinned to the guild it was learned in", async () => {
  providerState.embedding = null;
  const tools = createMemoryTools(ctx({ userId: "saver-2" }));
  const result = await tools.memory_save.execute?.(
    { fact: "Lives in Amsterdam", category: undefined, scope: "global" },
    toolOpts
  );
  assert.deepEqual(result, {
    saved: true,
    fact: "Lives in Amsterdam",
    scope: "global",
  });

  const rows = await dbm.db
    .select()
    .from(dbm.userFacts)
    .where(eq(dbm.userFacts.userId, "saver-2"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.guildId, null);
});

test("memory_save has nothing to attach a fact to in an autonomous turn", async () => {
  const tools = createMemoryTools(ctx({ userId: null }));
  assert.deepEqual(
    await tools.memory_save.execute?.(
      { fact: "orphan", category: undefined, scope: "local" },
      toolOpts
    ),
    { error: "No user in context to attach the fact to." }
  );
});

// memory_search

test("memory_search short-circuits on a whitespace-only query", async () => {
  providerState.embedding = mockEmbedding([1, 0, 0]);
  const tools = createMemoryTools(ctx());
  assert.deepEqual(
    await tools.memory_search.execute?.({ query: "   " }, toolOpts),
    {
      results: [],
      reason: "empty_query",
    }
  );
  providerState.embedding = null;
});

test("memory_search reports the provider being off rather than failing", async () => {
  providerState.embedding = null;
  const tools = createMemoryTools(ctx());
  assert.deepEqual(
    await tools.memory_search.execute?.({ query: "anything" }, toolOpts),
    { results: [], reason: "embedding_disabled" }
  );
});

test("memory_search returns the nearest messages in this channel only", async () => {
  const dims = dbm.EMBEDDING_DIMENSIONS;
  const [conversation] = await dbm.db
    .insert(dbm.conversations)
    .values({ channelId: "mem-search", guildId: "mem-guild", model: "test" })
    .returning();
  assert.ok(conversation);
  const [message] = await dbm.db
    .insert(dbm.messages)
    .values({
      conversationId: conversation.id,
      role: "user",
      content: "we agreed on Postgres",
      userId: "mem-user",
    })
    .returning();
  assert.ok(message);

  await dbm.db.insert(dbm.messageEmbeddings).values([
    {
      messageId: message.id,
      conversationId: conversation.id,
      channelId: "mem-search",
      userId: "mem-user",
      guildId: "mem-guild",
      content: "we agreed on Postgres",
      embedding: unitVector(0, dims),
    },
    // same axis, but a different channel — long-term memory is channel-scoped
    {
      channelId: "mem-other-channel",
      userId: "mem-user",
      guildId: "mem-guild",
      content: "a neighbouring channel said the same thing",
      embedding: unitVector(0, dims),
    },
    // orthogonal, so it falls below RAG_MIN_SIMILARITY
    {
      channelId: "mem-search",
      userId: "mem-user",
      guildId: "mem-guild",
      content: "completely unrelated chatter",
      embedding: unitVector(1, dims),
    },
  ]);

  providerState.embedding = mockEmbedding(unitVector(0, dims));
  const tools = createMemoryTools(ctx({ channelId: "mem-search" }));
  const result = (await tools.memory_search.execute?.(
    { query: "what database did we pick?" },
    toolOpts
  )) as {
    results: Array<{
      messageId: number | null;
      role: string | null;
      userId: string | null;
      createdAt: string | null;
      similarity: number;
      content: string;
    }>;
    reason?: string;
  };

  assert.equal(result.reason, undefined);
  assert.equal(result.results.length, 1);
  const hit = result.results[0];
  assert.equal(hit?.content, "we agreed on Postgres");
  assert.equal(hit?.messageId, message.id);
  // joined through to the message row
  assert.equal(hit?.role, "user");
  assert.equal(hit?.userId, "mem-user");
  assert.equal(typeof hit?.createdAt, "string");
  assert.ok(Math.abs((hit?.similarity ?? 0) - 1) < 1e-6);
  providerState.embedding = null;
});

test("memory_search truncates long stored content and tolerates an orphaned embedding", async () => {
  const dims = dbm.EMBEDDING_DIMENSIONS;
  const long = "y".repeat(900);
  await dbm.db.insert(dbm.messageEmbeddings).values({
    // no messageId: the message was deleted, the embedding outlived it
    messageId: null,
    channelId: "mem-long",
    userId: null,
    guildId: null,
    content: long,
    embedding: unitVector(2, dims),
  });

  providerState.embedding = mockEmbedding(unitVector(2, dims));
  const tools = createMemoryTools(ctx({ channelId: "mem-long" }));
  const result = (await tools.memory_search.execute?.(
    { query: "the long one" },
    toolOpts
  )) as {
    results: Array<{
      content: string;
      role: string | null;
      createdAt: string | null;
    }>;
  };

  assert.equal(result.results.length, 1);
  const hit = result.results[0];
  assert.equal(hit?.content, `${"y".repeat(600)}…`);
  // the left join found no message, so these come back null rather than throwing
  assert.equal(hit?.role, null);
  assert.equal(hit?.createdAt, null);
  providerState.embedding = null;
});

test("memory_search degrades to a reason when the embedding call fails", async () => {
  providerState.embedding = new MockEmbeddingModelV3({
    doEmbed: async () => {
      throw new Error("embedding service down");
    },
  }) as unknown as EmbeddingModel;

  const tools = createMemoryTools(ctx());
  assert.deepEqual(
    await tools.memory_search.execute?.({ query: "anything" }, toolOpts),
    { results: [], reason: "embedding_failed" }
  );
  providerState.embedding = null;
});

test("memory_search degrades to a reason when the query fails", async () => {
  const dims = dbm.EMBEDDING_DIMENSIONS;
  providerState.embedding = mockEmbedding(unitVector(0, dims));
  const spy = vi.spyOn(dbm.db, "select").mockImplementationOnce(() => {
    throw new Error("connection terminated");
  });

  const tools = createMemoryTools(ctx());
  assert.deepEqual(
    await tools.memory_search.execute?.({ query: "anything" }, toolOpts),
    { results: [], reason: "db_error" }
  );

  spy.mockRestore();
  providerState.embedding = null;
});

test("memory_search needs a channel to scope by", async () => {
  const dims = dbm.EMBEDDING_DIMENSIONS;
  providerState.embedding = mockEmbedding(unitVector(0, dims));
  // channelId is typed as required, but tool contexts are assembled at runtime
  const tools = createMemoryTools(ctx({ channelId: "" }));
  assert.deepEqual(
    await tools.memory_search.execute?.({ query: "anything" }, toolOpts),
    { results: [], reason: "channel_not_found" }
  );
  providerState.embedding = null;
});
