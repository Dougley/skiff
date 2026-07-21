import { generateText, Output } from "ai";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getLLMProvider } from "../../../ai/llm/provider.js";
import {
  linkStorylineEvents,
  WAKE_RELATIONS,
} from "../../../ai/logbook/store.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import {
  db,
  sleepCycleChanges,
  storylineEventLinks,
  storylineEvents,
  storylines,
} from "../../../db/index.js";
import { addStat, type DreamContext, logChange } from "../context.js";

const PHASE = "trace_wake";
const MIN_CONFIDENCE = 90;

const proposalSchema = z.object({
  links: z
    .array(
      z.object({
        fromEventId: z.number().int(),
        relation: z.enum(WAKE_RELATIONS),
        toEventId: z.number().int(),
        rationale: z.string().min(1),
        confidence: z.number().min(0).max(100),
      })
    )
    .max(10)
    .default([]),
});

/** Discover explicit causal statements already present in recent Logbook history. */
export async function traceWake(ctx: DreamContext): Promise<void> {
  const modelId = env.MEMORY_EXTRACT_MODEL ?? env.LLM_DEFAULT_MODEL;
  if (modelId === "disabled" || (!ctx.guildId && !ctx.channelId)) return;

  const events = await db
    .select({
      id: storylineEvents.id,
      kind: storylineEvents.kind,
      summary: storylineEvents.summary,
      details: storylineEvents.details,
      storylineId: storylines.id,
      storylineTitle: storylines.title,
    })
    .from(storylineEvents)
    .innerJoin(storylines, eq(storylineEvents.storylineId, storylines.id))
    .where(
      ctx.guildId
        ? eq(storylines.guildId, ctx.guildId)
        : and(
            sql`${storylines.guildId} is null`,
            eq(storylines.channelId, ctx.channelId as string)
          )
    )
    .orderBy(desc(storylineEvents.createdAt))
    .limit(40);
  if (events.length < 2) return;
  addStat(ctx, PHASE, "eventsConsidered", events.length);

  const ids = events.map((event) => event.id);
  const existing = await db
    .select()
    .from(storylineEventLinks)
    .where(
      and(
        inArray(storylineEventLinks.fromEventId, ids),
        inArray(storylineEventLinks.toEventId, ids)
      )
    );
  const existingKeys = new Set(
    existing.map(
      (link) => `${link.fromEventId}:${link.relation}:${link.toEventId}`
    )
  );

  let proposed: z.infer<typeof proposalSchema>;
  try {
    const result = await generateText({
      model: getLLMProvider(undefined, modelId),
      output: Output.object({ schema: proposalSchema }),
      prompt: [
        "Find causal or evidentiary links that are EXPLICIT in these Logbook events.",
        "Read each result as: FROM supports/depends on/contradicts/supersedes/was caused by TO.",
        "Do not infer plausible relationships. Return nothing unless the wording itself establishes the link.",
        `Only return links with at least ${MIN_CONFIDENCE}% confidence.`,
        "Do not repeat an existing link.",
        "",
        `Existing: ${[...existingKeys].join(", ") || "none"}`,
        "Events:",
        ...events.map(
          (event) =>
            `- #${event.id} [${event.kind}] (${event.storylineTitle}) ${event.summary}${event.details ? ` — ${event.details}` : ""}`
        ),
      ].join("\n"),
      maxRetries: 1,
    });
    proposed = result.output;
    ctx.tokenUsage +=
      (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0);
  } catch (err) {
    logger.warn("sleep: trace-wake LLM failed", { err });
    return;
  }

  const validIds = new Set(ids);
  for (const proposal of proposed.links) {
    const key = `${proposal.fromEventId}:${proposal.relation}:${proposal.toEventId}`;
    if (
      proposal.confidence < MIN_CONFIDENCE ||
      proposal.fromEventId === proposal.toEventId ||
      !validIds.has(proposal.fromEventId) ||
      !validIds.has(proposal.toEventId) ||
      existingKeys.has(key)
    ) {
      continue;
    }

    const changeId = await logChange({
      runId: ctx.runId,
      kind: "wake_link",
      targetTable: "storyline_event_links",
      before: null,
      after: proposal,
    });
    addStat(ctx, PHASE, "linksProposed");
    if (ctx.dryRun) continue;

    const link = await linkStorylineEvents({
      guildId: ctx.guildId,
      channelId: ctx.channelId ?? "",
      ...proposal,
    });
    if (!link) continue;
    existingKeys.add(key);
    addStat(ctx, PHASE, "linksWritten");
    if (changeId != null) {
      await db
        .update(sleepCycleChanges)
        .set({ targetId: String(link.id) })
        .where(eq(sleepCycleChanges.id, changeId));
    }
  }
}
