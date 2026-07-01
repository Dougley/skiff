import { tool } from "@ai-sdk/provider-utils";
import { type Embedding, embed } from "ai";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { db, messageEmbeddings, messages } from "../../db/index.js";
import { embeddingProvider } from "../llm/provider.js";
import {
  normalizeEmbeddingDimensions,
  toVectorLiteral,
} from "../memory/vector.js";
import type { DiscordToolContext } from "./discord.js";

type MemoryMatch = {
  messageId: number | null;
  role: string | null;
  userId: string | null;
  createdAt: string | null;
  similarity: number;
  content: string;
};

type MemorySearchResult = {
  results: MemoryMatch[];
  reason?:
    | "embedding_disabled"
    | "empty_query"
    | "embedding_failed"
    | "db_error"
    | "channel_not_found";
};

const MAX_CONTENT_CHARS = 600;

const normalizeContent = (content: string) =>
  content.length > MAX_CONTENT_CHARS
    ? `${content.slice(0, MAX_CONTENT_CHARS)}…`
    : content;

// scoped by channel (not conversation UUID) so long-term memory survives /clear
function buildSimilarityQuery(
  embedding: Embedding,
  channelId: string
): Promise<MemoryMatch[]> {
  const vector = sql`${toVectorLiteral(normalizeEmbeddingDimensions(embedding))}::vector`;
  const distance = sql<number>`(${messageEmbeddings.embedding} <=> ${vector})`;
  const similarity = sql<number>`(1 - ${distance})`;

  return db
    .select({
      messageId: messageEmbeddings.messageId,
      role: messages.role,
      userId: messageEmbeddings.userId,
      createdAt: messages.createdAt,
      similarity,
      content: messageEmbeddings.content,
    })
    .from(messageEmbeddings)
    .leftJoin(messages, eq(messages.id, messageEmbeddings.messageId))
    .where(
      and(
        eq(messageEmbeddings.channelId, channelId),
        sql`${messageEmbeddings.embedding} is not null`,
        sql`${similarity} >= ${env.RAG_MIN_SIMILARITY}`
      )
    )
    .orderBy(distance)
    .limit(env.RAG_TOP_K)
    .then((rows) =>
      rows.map((row) => ({
        messageId: row.messageId,
        role: row.role ?? null,
        userId: row.userId ?? null,
        createdAt: row.createdAt?.toISOString() ?? null,
        similarity: row.similarity,
        content: normalizeContent(row.content),
      }))
    );
}

export const createMemoryTools = (ctx: DiscordToolContext) => ({
  memory_search: tool({
    description:
      "Search conversation memory with semantic similarity. Use when you need relevant past context.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Natural language search query."),
    }),
    execute: async ({ query }): Promise<MemorySearchResult> => {
      if (!query.trim()) {
        logger.debug("memory_search skipped: empty query");
        return { results: [], reason: "empty_query" };
      }

      if (!embeddingProvider) {
        logger.debug("memory_search disabled: no embedding provider");
        return { results: [], reason: "embedding_disabled" };
      }

      const channelId = ctx.channelId;
      if (!channelId) {
        return { results: [], reason: "channel_not_found" };
      }

      let embedding: Embedding;
      try {
        const embedResult = await embed({
          model: embeddingProvider,
          value: query,
        });
        embedding = normalizeEmbeddingDimensions(embedResult.embedding);
        logger.debug("memory_search embedding created", {
          queryLength: query.length,
        });
      } catch (err) {
        logger.warn("memory_search: embedding failed", { err });
        return { results: [], reason: "embedding_failed" };
      }

      try {
        const results = await buildSimilarityQuery(embedding, channelId);
        logger.debug("memory_search results", {
          resultCount: results.length,
        });
        return { results };
      } catch (err) {
        logger.warn("memory_search: query failed", { err });
        return { results: [], reason: "db_error" };
      }
    },
  }),
});
