import { generateObject } from "ai";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { getLLMProvider } from "../../../ai/llm/provider.js";
import { insertTopicSummary } from "../../../ai/memory/store.js";
import { cosineSimilarity } from "../../../ai/memory/vector.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { db, messageEmbeddings, topicKnowledge } from "../../../db/index.js";
import {
  SLEEP_CLUSTER_THRESHOLD,
  SLEEP_MAX_CLUSTERS_PER_RUN,
  SLEEP_MAX_SAMPLES,
  SLEEP_MIN_CLUSTER_SIZE,
  SLEEP_NEW_TOPIC_OVERLAP_THRESHOLD,
  SLEEP_SYNTHESIZE_LOOKBACK_MS,
} from "../config.js";
import { addStat, type DreamContext, logChange } from "../context.js";

const PHASE = "synthesize_topics";

const synthSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string()).default([]),
});

/**
 * Greedy-cluster recent message embeddings. For clusters of size >= 5 that
 * aren't already covered by an existing topic (cosine < 0.85 to any active
 * topic), synthesize a new topic summary and insert it.
 */
export async function synthesizeTopics(ctx: DreamContext): Promise<void> {
  // Gate the LLM dependency up front so we don't burn CPU on clustering when
  // we can't synthesize anyway.
  const modelId = env.MEMORY_EXTRACT_MODEL ?? env.LLM_DEFAULT_MODEL;
  if (modelId === "disabled") return;

  const cutoff = new Date(ctx.now.getTime() - SLEEP_SYNTHESIZE_LOOKBACK_MS);

  const rows = await db
    .select({
      id: messageEmbeddings.id,
      content: messageEmbeddings.content,
      embedding: messageEmbeddings.embedding,
      createdAt: messageEmbeddings.createdAt,
    })
    .from(messageEmbeddings)
    .where(
      and(
        // DM scope clusters only that channel's embeddings
        ctx.channelId !== null
          ? eq(messageEmbeddings.channelId, ctx.channelId)
          : ctx.guildId === null
            ? sql`${messageEmbeddings.guildId} is null`
            : eq(messageEmbeddings.guildId, ctx.guildId),
        gt(messageEmbeddings.createdAt, cutoff)
      )
    )
    .orderBy(desc(messageEmbeddings.createdAt))
    .limit(SLEEP_MAX_SAMPLES);

  const usable = rows.filter((r): r is typeof r & { embedding: number[] } =>
    Array.isArray(r.embedding)
  );
  if (usable.length < SLEEP_MIN_CLUSTER_SIZE) return;
  addStat(ctx, PHASE, "samplesConsidered", usable.length);

  // Index by id once so the per-cluster lookups are O(1) instead of O(n).
  const byId = new Map(usable.map((u) => [u.id, u]));

  // Load existing topics for this guild to suppress duplicates of known subjects.
  const existingTopics = await db
    .select({
      id: topicKnowledge.id,
      embedding: topicKnowledge.embedding,
    })
    .from(topicKnowledge)
    .where(
      and(
        eq(topicKnowledge.active, true),
        // compare against topics in the same scope the synthesized ones land in
        ctx.channelId !== null
          ? eq(topicKnowledge.channelId, ctx.channelId)
          : ctx.guildId === null
            ? sql`${topicKnowledge.guildId} is null and ${topicKnowledge.channelId} is null`
            : eq(topicKnowledge.guildId, ctx.guildId),
        sql`${topicKnowledge.embedding} is not null`
      )
    );

  // Suppression set we extend as we go so two clusters in the same run don't
  // both create the same new topic.
  const suppressEmbeddings: number[][] = existingTopics
    .map((t) => t.embedding)
    .filter((e): e is number[] => Array.isArray(e));

  const assigned = new Set<number>();
  const clusters: { seed: number; members: number[] }[] = [];

  for (const seed of usable) {
    if (assigned.has(seed.id)) continue;
    const members: number[] = [seed.id];
    for (const other of usable) {
      if (other.id === seed.id || assigned.has(other.id)) continue;
      if (
        cosineSimilarity(seed.embedding, other.embedding) >=
        SLEEP_CLUSTER_THRESHOLD
      ) {
        members.push(other.id);
      }
    }
    if (members.length >= SLEEP_MIN_CLUSTER_SIZE) {
      clusters.push({ seed: seed.id, members });
      for (const m of members) assigned.add(m);
    }
    if (clusters.length >= SLEEP_MAX_CLUSTERS_PER_RUN) break;
  }

  addStat(ctx, PHASE, "clustersFound", clusters.length);
  if (clusters.length === 0) return;

  for (const cluster of clusters) {
    const seedEmbedding = byId.get(cluster.seed)?.embedding;
    if (!seedEmbedding) continue;

    // Skip if a similar topic already exists (or was just synthesized this run).
    const duplicate = suppressEmbeddings.some(
      (e) =>
        cosineSimilarity(e, seedEmbedding) >= SLEEP_NEW_TOPIC_OVERLAP_THRESHOLD
    );
    if (duplicate) {
      addStat(ctx, PHASE, "clustersSkippedDup");
      continue;
    }

    const excerpts = cluster.members
      .map((id) => byId.get(id)?.content ?? "")
      .filter(Boolean)
      .slice(0, 12)
      .map((c, i) => `[${i + 1}] ${c.slice(0, 400)}`);

    let synth: z.infer<typeof synthSchema>;
    try {
      const r = await generateObject({
        model: getLLMProvider(undefined, modelId),
        schema: synthSchema,
        prompt: [
          "Summarize the common topic connecting these message excerpts. Return a concise title, a 2-3 sentence summary, and a few tags.",
          "If the messages don't actually share a topic, return a title of 'NO_TOPIC' — the caller will discard it.",
          "",
          ...excerpts,
        ].join("\n"),
        maxRetries: 1,
      });
      synth = r.object;
      ctx.tokenUsage +=
        (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
    } catch (err) {
      logger.warn("sleep: synthesize-topics LLM failed", { err });
      continue;
    }

    if (synth.title === "NO_TOPIC") {
      addStat(ctx, PHASE, "clustersRejected");
      continue;
    }

    let insertedId: number | null = null;
    if (!ctx.dryRun) {
      const inserted = await insertTopicSummary({
        guildId: ctx.guildId,
        channelId: ctx.channelId,
        createdByUserId: null,
        sourceConversationId: null,
        summary: {
          title: synth.title,
          summary: synth.summary,
          tags: synth.tags ?? [],
        },
      });
      insertedId = inserted?.id ?? null;
    }

    await logChange({
      runId: ctx.runId,
      kind: "topic_new",
      targetTable: "topic_knowledge",
      targetId: insertedId,
      before: null,
      after: {
        title: synth.title,
        summary: synth.summary,
        tags: synth.tags,
        memberIds: cluster.members.slice(0, 25),
      },
    });
    addStat(ctx, PHASE, "topicsCreated");
    // Suppress further clusters in this run that would re-synthesize the
    // same topic. Best-effort — uses the cluster seed embedding as proxy
    // since we don't re-embed the synthesized title here.
    suppressEmbeddings.push(seedEmbedding);
  }
}
