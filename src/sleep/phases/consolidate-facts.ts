import { generateObject } from "ai";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import { db, messages, userFacts } from "../../db/index.js";
import { env } from "../../env/index.js";
import { getLLMProvider } from "../../llm/provider.js";
import { logger } from "../../logger/index.js";
import {
  SLEEP_CONSOLIDATE_LOOKBACK_MS,
  SLEEP_CONSOLIDATE_MAX_USERS,
  SLEEP_CONSOLIDATE_MIN_FACTS,
} from "../config.js";
import { addStat, type DreamContext, logChange } from "../context.js";

const PHASE = "consolidate_facts";

const resolutionSchema = z.object({
  resolutions: z
    .array(
      z.object({
        keepId: z.number().int().describe("ID of the fact to keep active."),
        retireIds: z
          .array(z.number().int())
          .describe("IDs of facts to mark superseded by keepId."),
        reason: z.string().min(1),
      })
    )
    .default([]),
});

/**
 * Detect contradictions between a user's active facts and supersede the
 * losers. Only runs on users who've been active in the last 30 days and have
 * at least 2 facts in the same guild scope.
 */
export async function consolidateFacts(ctx: DreamContext): Promise<void> {
  const modelId = env.MEMORY_EXTRACT_MODEL ?? env.LLM_DEFAULT_MODEL;
  if (modelId === "disabled") return;

  // find recently active users in this guild scope
  const cutoff = new Date(ctx.now.getTime() - SLEEP_CONSOLIDATE_LOOKBACK_MS);
  const recentUsers = await db
    .selectDistinct({ userId: messages.userId })
    .from(messages)
    .where(
      and(
        gt(messages.createdAt, cutoff),
        sql`${messages.userId} is not null`,
        eq(messages.role, "user"),
        ctx.guildId === null
          ? sql`${messages.conversationId} in (select id from conversations where guild_id is null)`
          : sql`${messages.conversationId} in (select id from conversations where guild_id = ${ctx.guildId})`
      )
    )
    .limit(SLEEP_CONSOLIDATE_MAX_USERS);

  for (const { userId } of recentUsers) {
    if (!userId) continue;

    const facts = await db
      .select({
        id: userFacts.id,
        fact: userFacts.fact,
        category: userFacts.category,
        confidence: userFacts.confidence,
        createdAt: userFacts.createdAt,
      })
      .from(userFacts)
      .where(
        and(
          eq(userFacts.userId, userId),
          eq(userFacts.active, true),
          ctx.guildId === null
            ? sql`${userFacts.guildId} is null`
            : sql`(${userFacts.guildId} = ${ctx.guildId} or ${userFacts.guildId} is null)`
        )
      )
      .orderBy(desc(userFacts.updatedAt))
      .limit(50);

    if (facts.length < SLEEP_CONSOLIDATE_MIN_FACTS) continue;
    addStat(ctx, PHASE, "usersScanned");

    const prompt = [
      "You are consolidating memory about a user. Find pairs/groups of facts that contradict each other (e.g. two different favorite colors, conflicting preferences).",
      "For each contradiction, pick the most plausible fact to keep (prefer newer, higher-confidence, more specific) and list the IDs of facts it supersedes.",
      "Do NOT emit a resolution for facts that are merely overlapping, complementary, or on different topics. Only emit resolutions when facts are mutually exclusive.",
      "",
      "Active facts:",
      ...facts.map(
        (f) =>
          `- id=${f.id} [${f.category ?? "-"}] conf=${f.confidence ?? 80} "${f.fact}"`
      ),
    ].join("\n");

    let result: z.infer<typeof resolutionSchema>;
    try {
      const r = await generateObject({
        model: getLLMProvider(undefined, modelId),
        schema: resolutionSchema,
        prompt,
        maxRetries: 1,
      });
      result = r.object;
      ctx.tokenUsage +=
        (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
    } catch (err) {
      logger.warn("sleep: consolidate-facts LLM failed", { userId, err });
      continue;
    }

    for (const res of result.resolutions) {
      const keep = facts.find((f) => f.id === res.keepId);
      if (!keep) continue;
      const retires = res.retireIds.filter(
        (id) => id !== res.keepId && facts.some((f) => f.id === id)
      );
      if (retires.length === 0) continue;

      await logChange({
        runId: ctx.runId,
        kind: "fact_resolve",
        targetTable: "user_facts",
        targetId: res.keepId,
        before: { retireIds: retires, keepId: res.keepId },
        after: { reason: res.reason },
      });
      addStat(ctx, PHASE, "resolutions");

      if (ctx.dryRun) continue;

      await db.transaction(async (tx) => {
        for (const rid of retires) {
          await tx
            .update(userFacts)
            .set({
              active: false,
              supersededBy: res.keepId,
              updatedAt: ctx.now,
            })
            .where(eq(userFacts.id, rid));
        }
      });
      addStat(ctx, PHASE, "factsRetired", retires.length);
    }
  }
}
