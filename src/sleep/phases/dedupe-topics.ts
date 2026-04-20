import { generateObject } from "ai";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db, topicKnowledge } from "../../db/index.js";
import { env } from "../../env/index.js";
import { getLLMProvider } from "../../llm/provider.js";
import { logger } from "../../logger/index.js";
import { addStat, type DreamContext, logChange } from "../context.js";

const PHASE = "dedupe_topics";
const SIMILARITY_THRESHOLD = 0.9;
const MAX_TOPICS = 200;
const MAX_MERGES_PER_RUN = 20;

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

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Find near-duplicate topic knowledge entries (cosine > 0.9) and merge them.
 * The loser is marked active=false with supersededBy set to the canonical id.
 */
export async function dedupeTopics(ctx: DreamContext): Promise<void> {
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
        ctx.guildId === null
          ? sql`${topicKnowledge.guildId} is null`
          : eq(topicKnowledge.guildId, ctx.guildId),
        sql`${topicKnowledge.embedding} is not null`
      )
    )
    .limit(MAX_TOPICS);

  if (topics.length < 2) return;
  addStat(ctx, PHASE, "topicsScanned", topics.length);

  const retired = new Set<number>();
  let merges = 0;

  for (let i = 0; i < topics.length && merges < MAX_MERGES_PER_RUN; i++) {
    const a = topics[i];
    if (!a || retired.has(a.id) || !a.embedding) continue;

    for (let j = i + 1; j < topics.length; j++) {
      const b = topics[j];
      if (!b || retired.has(b.id) || !b.embedding) continue;

      const sim = cosineSimilarity(a.embedding, b.embedding);
      if (sim < SIMILARITY_THRESHOLD) continue;

      const modelId = env.MEMORY_EXTRACT_MODEL ?? env.LLM_DEFAULT_MODEL;
      if (modelId === "disabled") return;

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
      } catch (err) {
        logger.warn("sleep: dedupe-topics LLM failed", {
          aId: a.id,
          bId: b.id,
          err,
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
          canonical: { id: canonical.id, summary: canonical.summary },
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
