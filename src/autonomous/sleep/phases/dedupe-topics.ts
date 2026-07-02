import { generateObject } from "ai";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { getLLMProvider } from "../../../ai/llm/provider.js";
import { cosineSimilarity } from "../../../ai/memory/vector.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { db, topicKnowledge } from "../../../db/index.js";
import {
  SLEEP_DEDUPE_SIMILARITY,
  SLEEP_MAX_MERGES_PER_RUN,
  SLEEP_MAX_TOPICS,
} from "../config.js";
import { addStat, type DreamContext, logChange } from "../context.js";

const PHASE = "dedupe_topics";

const mergeSchema = z.object({
  canonicalId: z
    .number()
    .int()
    .describe("ID of the topic to keep — the better-titled, richer summary."),
  mergedSummary: z
    .string()
    .min(1)
    .describe("Combined summary that covers both topics' content."),
  mergedTags: z.array(z.string()).default([]),
});

/**
 * Find near-duplicate topic knowledge entries (cosine > 0.9) and merge them.
 * The loser is marked active=false with supersededBy set to the canonical id.
 */
export async function dedupeTopics(ctx: DreamContext): Promise<void> {
  const modelId = env.MEMORY_EXTRACT_MODEL ?? env.LLM_DEFAULT_MODEL;
  if (modelId === "disabled") return;

  const topics = await db
    .select({
      id: topicKnowledge.id,
      title: topicKnowledge.title,
      summary: topicKnowledge.summary,
      tags: topicKnowledge.tags,
      embedding: topicKnowledge.embedding,
      createdAt: topicKnowledge.createdAt,
    })
    .from(topicKnowledge)
    .where(
      and(
        eq(topicKnowledge.active, true),
        // null-scope runs only touch legacy/global topics — channel (DM)
        // topics are never merged across different DMs
        ctx.guildId === null
          ? sql`${topicKnowledge.guildId} is null and ${topicKnowledge.channelId} is null`
          : eq(topicKnowledge.guildId, ctx.guildId),
        sql`${topicKnowledge.embedding} is not null`
      )
    )
    .limit(SLEEP_MAX_TOPICS);

  if (topics.length < 2) return;
  addStat(ctx, PHASE, "topicsScanned", topics.length);

  const retired = new Set<number>();
  let merges = 0;

  for (let i = 0; i < topics.length && merges < SLEEP_MAX_MERGES_PER_RUN; i++) {
    const a = topics[i];
    if (!a || retired.has(a.id) || !a.embedding) continue;

    for (let j = i + 1; j < topics.length; j++) {
      const b = topics[j];
      if (!b || retired.has(b.id) || !b.embedding) continue;

      const sim = cosineSimilarity(a.embedding, b.embedding);
      if (sim < SLEEP_DEDUPE_SIMILARITY) continue;

      let merged: z.infer<typeof mergeSchema>;
      try {
        const r = await generateObject({
          model: getLLMProvider(undefined, modelId),
          schema: mergeSchema,
          prompt: [
            "Two topic knowledge entries appear to cover the same subject. Pick the stronger title as canonical and write a single combined summary that preserves unique detail from both.",
            "",
            `Topic A (id=${a.id}): ${a.title}`,
            `Summary: ${a.summary}`,
            `Tags: ${(a.tags ?? []).join(", ")}`,
            "",
            `Topic B (id=${b.id}): ${b.title}`,
            `Summary: ${b.summary}`,
            `Tags: ${(b.tags ?? []).join(", ")}`,
          ].join("\n"),
          maxRetries: 1,
        });
        merged = r.object;
        ctx.tokenUsage +=
          (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
      } catch (err) {
        logger.warn("sleep: dedupe-topics LLM failed", {
          aId: a.id,
          bId: b.id,
          err,
        });
        continue;
      }

      if (merged.canonicalId !== a.id && merged.canonicalId !== b.id) {
        logger.warn("sleep: dedupe-topics LLM returned unknown canonical id", {
          aId: a.id,
          bId: b.id,
          canonicalId: merged.canonicalId,
        });
        continue;
      }

      const canonical = merged.canonicalId === b.id ? b : a;
      const loser = merged.canonicalId === b.id ? a : b;

      await logChange({
        runId: ctx.runId,
        kind: "topic_merge",
        targetTable: "topic_knowledge",
        targetId: canonical.id,
        before: {
          canonical: {
            id: canonical.id,
            summary: canonical.summary,
            tags: canonical.tags ?? [],
          },
          loser: { id: loser.id, title: loser.title, summary: loser.summary },
        },
        after: {
          mergedSummary: merged.mergedSummary,
          mergedTags: merged.mergedTags,
        },
      });
      addStat(ctx, PHASE, "merges");
      merges++;

      if (!ctx.dryRun) {
        await db.transaction(async (tx) => {
          await tx
            .update(topicKnowledge)
            .set({
              summary: merged.mergedSummary,
              tags: merged.mergedTags.length
                ? merged.mergedTags
                : canonical.tags,
              updatedAt: ctx.now,
            })
            .where(eq(topicKnowledge.id, canonical.id));
          await tx
            .update(topicKnowledge)
            .set({
              active: false,
              supersededBy: canonical.id,
              updatedAt: ctx.now,
            })
            .where(eq(topicKnowledge.id, loser.id));
        });
      }
      retired.add(loser.id);
      if (loser.id === a.id) break; // a is retired, stop pairing it
    }
  }
}
