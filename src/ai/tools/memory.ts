import { tool } from "@ai-sdk/provider-utils";
import { type Embedding, embed } from "ai";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import {
  conversations,
  db,
  messageEmbeddings,
  messages,
} from "../../db/index.js";
import { embeddingProvider } from "../llm/provider.js";
import {
  normalizeEmbeddingDimensions,
  toVectorLiteral,
} from "../memory/vector.js";
import type { DiscordToolContext } from "./discord.js";

type MemoryMatch = {
  messageId: number;
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
    | "conversation_not_found";
};

const MAX_CONTENT_CHARS = 600;

const normalizeContent = (content: string) =>
  content.length > MAX_CONTENT_CHARS
    ? `${content.slice(0, MAX_CONTENT_CHARS)}…`
    : content;

async function resolveConversationId(
  ctx: DiscordToolContext
): Promise<string | null> {
  if (!ctx.channelId) return null;
  const match = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      ctx.guildId
        ? and(
            eq(conversations.channelId, ctx.channelId),
            eq(conversations.guildId, ctx.guildId)
          )
        : eq(conversations.channelId, ctx.channelId)
    )
    .limit(1);
  return match[0]?.id ?? null;
}

function buildSimilarityQuery(
  embedding: Embedding,
  conversationId: string
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
        eq(messageEmbeddings.conversationId, conversationId),
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

      const conversationId = await resolveConversationId(ctx);
      if (!conversationId) {
        return { results: [], reason: "conversation_not_found" };
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
        const results = await buildSimilarityQuery(embedding, conversationId);
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
