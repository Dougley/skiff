import { tool } from "@ai-sdk/provider-utils";
import { type Embedding, embed } from "ai";
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { db, topicKnowledge } from "../../db/index.js";
import { embeddingProvider } from "../llm/provider.js";
import {
  normalizeEmbeddingDimensions,
  toVectorLiteral,
} from "../memory/vector.js";
import type { DiscordToolContext } from "./discord.js";

type TopicMatch = {
  title: string;
  summary: string;
  tags: string[];
  similarity: number;
  createdAt: string | null;
};

type TopicSearchResult = {
  results: TopicMatch[];
  reason?:
    | "embedding_disabled"
    | "empty_query"
    | "embedding_failed"
    | "db_error";
};

/**
 * Scope visibility for topic knowledge: guilds see only their own topics;
 * DMs see that channel's topics plus legacy/global (both-null) entries.
 * Guild knowledge never leaks into DMs and vice versa.
 */
export function topicScopeFilter(
  guildId: string | null,
  channelId?: string | null
) {
  if (guildId) return eq(topicKnowledge.guildId, guildId);
  const legacyGlobal = sql`${topicKnowledge.guildId} is null and ${topicKnowledge.channelId} is null`;
  if (channelId) {
    return or(eq(topicKnowledge.channelId, channelId), legacyGlobal);
  }
  return legacyGlobal;
}

async function queryTopics(
  embedding: Embedding,
  guildId: string | null,
  channelId: string | null
): Promise<TopicMatch[]> {
  const vector = sql`${toVectorLiteral(normalizeEmbeddingDimensions(embedding))}::vector`;
  const distance = sql<number>`(${topicKnowledge.embedding} <=> ${vector})`;
  const similarity = sql<number>`(1 - ${distance})`;

  return db
    .select({
      title: topicKnowledge.title,
      summary: topicKnowledge.summary,
      tags: topicKnowledge.tags,
      similarity,
      createdAt: topicKnowledge.createdAt,
    })
    .from(topicKnowledge)
    .where(
      and(
        eq(topicKnowledge.active, true),
        sql`${topicKnowledge.embedding} is not null`,
        topicScopeFilter(guildId, channelId),
        sql`${similarity} >= ${env.RAG_MIN_SIMILARITY}`
      )
    )
    .orderBy(distance)
    .limit(env.RAG_TOP_K)
    .then((rows) =>
      rows.map((row) => ({
        title: row.title,
        summary: row.summary,
        tags: row.tags ?? [],
        similarity: row.similarity,
        createdAt: row.createdAt?.toISOString() ?? null,
      }))
    );
}

export const createTopicTools = (ctx: DiscordToolContext) => ({
  topic_search: tool({
    description:
      "Search stored topic knowledge for relevant summaries. Use when you need broader context.",
    inputSchema: z.object({
      query: z.string().min(1).describe("Natural language search query."),
    }),
    execute: async ({ query }): Promise<TopicSearchResult> => {
      if (!query.trim()) {
        logger.debug("topic_search skipped: empty query");
        return { results: [], reason: "empty_query" };
      }

      const model = embeddingProvider;
      if (!model) {
        logger.debug("topic_search disabled: no embedding provider");
        return { results: [], reason: "embedding_disabled" };
      }

      let embedding: Embedding;
      try {
        const result = await embed({ model, value: query });
        embedding = normalizeEmbeddingDimensions(result.embedding);
        logger.debug("topic_search embedding created", {
          queryLength: query.length,
        });
      } catch (err) {
        logger.warn("topic_search: embedding failed", { err });
        return { results: [], reason: "embedding_failed" };
      }

      try {
        const results = await queryTopics(
          embedding,
          ctx.guildId ?? null,
          ctx.channelId ?? null
        );
        logger.debug("topic_search results", {
          resultCount: results.length,
        });
        return { results };
      } catch (err) {
        logger.warn("topic_search: query failed", { err });
        return { results: [], reason: "db_error" };
      }
    },
  }),
});
