import { type Embedding, embed } from "ai";
import { and, eq, sql } from "drizzle-orm";
import { db, topicKnowledge, userFacts } from "../db/index.js";
import { embeddingProvider } from "../llm/provider.js";
import { logger } from "../logger/index.js";
import type { MemoryExtraction } from "./extract.js";
import { normalizeEmbeddingDimensions } from "./vector.js";

export type UserFactInput = {
  fact: string;
  category?: string;
  confidence?: number;
  guildScoped?: boolean;
};

export async function upsertUserFacts(params: {
  userId: string;
  guildId?: string | null;
  sourceMessageId?: number | null;
  facts: UserFactInput[];
}): Promise<number> {
  if (params.facts.length === 0) return 0;

  logger.debug("memory: upserting user facts", {
    userId: params.userId,
    guildId: params.guildId ?? null,
    factCount: params.facts.length,
  });

  let count = 0;

  await db.transaction(async (tx) => {
    for (const fact of params.facts) {
      const category = fact.category ?? null;
      const guildId = fact.guildScoped ? (params.guildId ?? null) : null;

      const scopeFilter = guildId
        ? eq(userFacts.guildId, guildId)
        : sql`${userFacts.guildId} is null`;

      const existing = await tx
        .select()
        .from(userFacts)
        .where(
          and(
            eq(userFacts.userId, params.userId),
            eq(userFacts.active, true),
            category ? eq(userFacts.category, category) : sql`true`,
            scopeFilter
          )
        )
        .limit(1);

      const inserted = await tx
        .insert(userFacts)
        .values({
          userId: params.userId,
          guildId,
          fact: fact.fact,
          category,
          confidence:
            typeof fact.confidence === "number"
              ? Math.round(Math.min(100, Math.max(0, fact.confidence)))
              : 80,
          active: true,
          sourceMessageId: params.sourceMessageId ?? null,
        })
        .returning();

      count += inserted.length;

      if (existing[0] && inserted[0]) {
        await tx
          .update(userFacts)
          .set({
            active: false,
            supersededBy: inserted[0].id,
            updatedAt: new Date(),
          })
          .where(eq(userFacts.id, existing[0].id));

        logger.debug("memory: superseded user fact", {
          userId: params.userId,
          category,
          previousId: existing[0].id,
          nextId: inserted[0].id,
        });
      }
    }
  });

  return count;
}

export async function insertTopicSummary(params: {
  guildId?: string | null;
  createdByUserId?: string | null;
  sourceConversationId?: string | null;
  summary: NonNullable<MemoryExtraction["topicSummary"]>;
}): Promise<{ id: number } | null> {
  const summary = params.summary;

  logger.debug("memory: inserting topic summary", {
    title: summary.title,
    tagCount: summary.tags?.length ?? 0,
    guildId: params.guildId ?? null,
  });

  const model = embeddingProvider;
  let embedding: Embedding | null = null;
  if (model) {
    try {
      const result = await embed({
        model,
        value: `${summary.title}\n${summary.summary}`,
      });
      embedding = normalizeEmbeddingDimensions(result.embedding);
      if (embedding.length > 0) {
        logger.debug("memory: topic embedding created", {
          title: summary.title,
        });
      }
    } catch (err) {
      logger.warn("topic embedding failed", { err });
    }
  } else {
    logger.debug("memory: topic embedding skipped (disabled)");
  }

  const [inserted] = await db
    .insert(topicKnowledge)
    .values({
      title: summary.title,
      summary: summary.summary,
      tags: summary.tags ?? [],
      guildId: params.guildId ?? null,
      createdByUserId: params.createdByUserId ?? null,
      sourceConversationId: params.sourceConversationId ?? null,
      embedding,
      active: true,
    })
    .returning({ id: topicKnowledge.id });

  logger.debug("memory: topic summary stored", {
    title: summary.title,
  });
  return inserted ?? null;
}

export async function storeExtraction(params: {
  userId?: string | null;
  guildId?: string | null;
  sourceMessageId?: number | null;
  sourceConversationId?: string | null;
  extraction: MemoryExtraction;
}): Promise<void> {
  const { extraction } = params;

  logger.debug("memory: storing extraction", {
    userId: params.userId ?? null,
    guildId: params.guildId ?? null,
    userFacts: extraction.userFacts.length,
    hasTopicSummary: Boolean(extraction.topicSummary),
  });

  if (params.userId && extraction.userFacts.length > 0) {
    await upsertUserFacts({
      userId: params.userId,
      guildId: params.guildId,
      sourceMessageId: params.sourceMessageId ?? null,
      facts: extraction.userFacts,
    });
  }

  if (extraction.topicSummary) {
    await insertTopicSummary({
      guildId: params.guildId ?? null,
      createdByUserId: params.userId ?? null,
      sourceConversationId: params.sourceConversationId ?? null,
      summary: extraction.topicSummary,
    });
  }
}
