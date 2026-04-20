import { generateObject } from "ai";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { db, messageEmbeddings, topicKnowledge } from "../../db/index.js";
import { env } from "../../env/index.js";
import { getLLMProvider } from "../../llm/provider.js";
import { logger } from "../../logger/index.js";
import { insertTopicSummary } from "../../memory/store.js";
import { addStat, type DreamContext, logChange } from "../context.js";

const PHASE = "synthesize_topics";
const CLUSTER_THRESHOLD = 0.85;
const MIN_CLUSTER_SIZE = 5;
const MAX_CLUSTERS_PER_RUN = 3;
const MAX_SAMPLES = 500;
const NEW_TOPIC_OVERLAP_THRESHOLD = 0.85;
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function cosine(a: number[], b: number[]): number {
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
  return denom === 0 ? 0 : dot / denom;
}

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
  const cutoff = new Date(ctx.now.getTime() - LOOKBACK_MS);

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
        ctx.guildId === null
          ? sql`${messageEmbeddings.guildId} is null`
          : eq(messageEmbeddings.guildId, ctx.guildId),
        gt(messageEmbeddings.createdAt, cutoff)
      )
    )
    .orderBy(desc(messageEmbeddings.createdAt))
    .limit(MAX_SAMPLES);

  const usable = rows.filter((r) => Array.isArray(r.embedding));
  if (usable.length < MIN_CLUSTER_SIZE) return;
  addStat(ctx, PHASE, "samplesConsidered", usable.length);

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
        ctx.guildId === null
          ? sql`${topicKnowledge.guildId} is null`
          : eq(topicKnowledge.guildId, ctx.guildId),
        sql`${topicKnowledge.embedding} is not null`
      )
    );

  const assigned = new Set<number>();
  const clusters: { seed: number; members: number[] }[] = [];

  for (const seed of usable) {
    if (assigned.has(seed.id) || !seed.embedding) continue;
    const members: number[] = [seed.id];
    for (const other of usable) {
      if (other.id === seed.id || assigned.has(other.id) || !other.embedding)
        continue;
      if (cosine(seed.embedding, other.embedding) >= CLUSTER_THRESHOLD) {
        members.push(other.id);
      }
    }
    if (members.length >= MIN_CLUSTER_SIZE) {
      clusters.push({ seed: seed.id, members });
      for (const m of members) assigned.add(m);
    }
    if (clusters.length >= MAX_CLUSTERS_PER_RUN) break;
  }

  addStat(ctx, PHASE, "clustersFound", clusters.length);
  if (clusters.length === 0) return;

  for (const cluster of clusters) {
    const seedEmbedding = usable.find((u) => u.id === cluster.seed)?.embedding;
    if (!seedEmbedding) continue;

    // Skip if a similar topic already exists.
    const duplicate = existingTopics.some(
      (t) =>
        t.embedding &&
        cosine(t.embedding, seedEmbedding) >= NEW_TOPIC_OVERLAP_THRESHOLD
    );
    if (duplicate) {
      addStat(ctx, PHASE, "clustersSkippedDup");
      continue;
    }

    const modelId = env.MEMORY_EXTRACT_MODEL ?? env.LLM_DEFAULT_MODEL;
    if (modelId === "disabled") return;

    const excerpts = cluster.members
      .map((id) => usable.find((u) => u.id === id)?.content ?? "")
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
    } catch (err) {
      logger.warn("sleep: synthesize-topics LLM failed", { err });
      continue;
    }

    if (synth.title === "NO_TOPIC") {
      addStat(ctx, PHASE, "clustersRejected");
      continue;
    }

    await logChange({
      runId: ctx.runId,
      kind: "topic_merge", // reusing kind for the change log; semantically a "topic_new"
      targetTable: "topic_knowledge",
      targetId: null,
      before: null,
      after: {
        new: true,
        title: synth.title,
        summary: synth.summary,
        tags: synth.tags,
        memberIds: cluster.members.slice(0, 25),
      },
    });
    addStat(ctx, PHASE, "topicsCreated");

    if (!ctx.dryRun) {
      await insertTopicSummary({
        guildId: ctx.guildId,
        createdByUserId: null,
        sourceConversationId: null,
        summary: {
          title: synth.title,
          summary: synth.summary,
          tags: synth.tags ?? [],
        },
      });
    }
  }
}
