import assert from "node:assert/strict";
import type { EmbeddingModel } from "ai";
import { MockEmbeddingModelV3 } from "ai/test";
import { eq } from "drizzle-orm";
import { beforeAll, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

// the enqueue path reads `embeddingProvider` at call time, so a getter-backed
// mock lets each test decide whether embeddings are on or off.
const providerState = vi.hoisted(() => ({ embedding: null as unknown }));

vi.mock("../../../src/ai/llm/provider.js", () => ({
  get embeddingProvider() {
    return providerState.embedding;
  },
  getEmbeddingProvider: () => providerState.embedding,
  getLLMProvider: () => {
    throw new Error("getLLMProvider must not be called by the embedding queue");
  },
  llmProvider: null,
}));

let embeddings: typeof import("../../../src/ai/memory/embeddings.js");
let dbm: typeof import("../../../src/db/index.js");
let conversationId: string;

beforeAll(async () => {
  const [{ runMigrations }, embeddingsModule, dbModule] = await Promise.all([
    import("../../../src/db/migrate.js"),
    import("../../../src/ai/memory/embeddings.js"),
    import("../../../src/db/index.js"),
  ]);
  await runMigrations();
  embeddings = embeddingsModule;
  dbm = dbModule;

  const [conversation] = await dbm.db
    .insert(dbm.conversations)
    .values({ channelId: "channel-1", guildId: "guild-2", model: "test" })
    .returning();
  assert.ok(conversation);
  conversationId = conversation.id;
});

const mockModel = (
  doEmbed: () => Promise<{
    embeddings: number[][];
    usage: { tokens: number };
    warnings: never[];
  }>
) => new MockEmbeddingModelV3({ doEmbed });

const constantModel = (values: number[]) =>
  mockModel(async () => ({
    embeddings: [values],
    usage: { tokens: values.length },
    warnings: [],
  }));

const useModel = (model: MockEmbeddingModelV3) => {
  providerState.embedding = model as unknown as EmbeddingModel;
  return model;
};

/** A real message row, so the embedding's foreign key resolves. */
async function seedMessage(content: string): Promise<number> {
  const [row] = await dbm.db
    .insert(dbm.messages)
    .values({ conversationId, role: "user", content })
    .returning({ id: dbm.messages.id });
  assert.ok(row);
  return row.id;
}

async function rowsFor(messageId: number) {
  return dbm.db
    .select()
    .from(dbm.messageEmbeddings)
    .where(eq(dbm.messageEmbeddings.messageId, messageId));
}

/** The write happens in a microtask, so poll until the row lands. */
async function waitForRow(messageId: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const rows = await rowsFor(messageId);
    if (rows.length > 0) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

/** Lets the queued microtask (and its awaits) settle without asserting a row. */
async function settle() {
  for (let tick = 0; tick < 10; tick++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const job = (messageId: number, content: string) => ({
  messageId,
  conversationId,
  channelId: "channel-1",
  content,
});

test("enqueueing is a no-op when the embedding provider is disabled", async () => {
  providerState.embedding = null;
  const messageId = await seedMessage("hello");

  assert.equal(
    await embeddings.enqueueEmbedding(job(messageId, "hello")),
    false
  );
  await settle();
  assert.equal((await rowsFor(messageId)).length, 0);
});

test("an enqueued job stores a dimension-normalized embedding", async () => {
  useModel(constantModel([0.5, 0.25, 0.125]));
  const messageId = await seedMessage("remember this");

  assert.equal(
    await embeddings.enqueueEmbedding({
      ...job(messageId, "remember this"),
      userId: "user-2",
      guildId: "guild-2",
    }),
    true
  );

  const row = await waitForRow(messageId);
  assert.ok(row);
  assert.equal(row.content, "remember this");
  assert.equal(row.userId, "user-2");
  assert.equal(row.guildId, "guild-2");
  assert.equal(row.channelId, "channel-1");
  assert.ok(row.embedding);
  // the model returned 3 dimensions; the column takes exactly EMBEDDING_DIMENSIONS
  assert.equal(row.embedding.length, dbm.EMBEDDING_DIMENSIONS);
  assert.ok(Math.abs((row.embedding[0] ?? 0) - 0.5) < 1e-6);
  assert.equal(row.embedding[dbm.EMBEDDING_DIMENSIONS - 1], 0);

  providerState.embedding = null;
});

test("optional attribution falls back to null rather than undefined", async () => {
  useModel(constantModel([1, 0, 0]));
  const messageId = await seedMessage("anonymous");

  await embeddings.enqueueEmbedding(job(messageId, "anonymous"));

  const row = await waitForRow(messageId);
  assert.ok(row);
  assert.equal(row.userId, null);
  assert.equal(row.guildId, null);

  providerState.embedding = null;
});

test("stored content is capped at 6000 characters", async () => {
  const model = useModel(constantModel([0.1, 0.1]));
  const messageId = await seedMessage("long");

  const long = "x".repeat(6500);
  await embeddings.enqueueEmbedding(job(messageId, long));

  const row = await waitForRow(messageId);
  assert.ok(row);
  assert.equal(row.content?.length, 6000);
  // the model still sees the full text — only the stored copy is trimmed
  assert.equal(model.doEmbedCalls[0]?.values[0]?.length, 6500);

  providerState.embedding = null;
});

test("content at the cap is stored verbatim", async () => {
  useModel(constantModel([0.2, 0.2]));
  const messageId = await seedMessage("at the cap");

  await embeddings.enqueueEmbedding(job(messageId, "y".repeat(6000)));

  const row = await waitForRow(messageId);
  assert.ok(row);
  assert.equal(row.content, "y".repeat(6000));

  providerState.embedding = null;
});

test("a failing embedding call is swallowed and writes nothing", async () => {
  useModel(
    mockModel(async () => {
      throw new Error("embedding backend unavailable");
    })
  );
  const messageId = await seedMessage("doomed");

  // the caller still gets `true`: the job was accepted, it just failed later
  assert.equal(
    await embeddings.enqueueEmbedding(job(messageId, "doomed")),
    true
  );
  await settle();
  assert.equal((await rowsFor(messageId)).length, 0);

  providerState.embedding = null;
});
