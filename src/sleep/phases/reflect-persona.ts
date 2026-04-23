import { generateObject } from "ai";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import {
  db,
  messages,
  personaAddenda,
  sleepCycleChanges,
} from "../../db/index.js";
import { env } from "../../env/index.js";
import { getLLMProvider } from "../../llm/provider.js";
import { logger } from "../../logger/index.js";
import { refreshAddendaCache } from "../addenda.js";
import {
  SLEEP_REFLECT_LOOKBACK_MS,
  SLEEP_REFLECT_MAX_ADDENDA_PER_RUN,
  SLEEP_REFLECT_MAX_MESSAGES,
  SLEEP_REFLECT_MIN_CONFIDENCE,
} from "../config.js";
import { addStat, type DreamContext, logChange } from "../context.js";

const PHASE = "reflect_persona";

const reflectionSchema = z.object({
  addenda: z
    .array(
      z.object({
        text: z
          .string()
          .min(1)
          .describe(
            "A durable note about the agent's growing self — short, first-person-agnostic. E.g. 'Tends to over-explain when uncertain; should default to shorter answers unless asked for depth.'"
          ),
        reason: z
          .string()
          .min(1)
          .describe("What in the observed conversations justifies this note."),
        confidence: z.number().min(0).max(100),
      })
    )
    .default([]),
});

/**
 * Reflect on recent conversations and propose durable persona addenda. Writes
 * only high-confidence (>=70) entries. Addenda survive restart and appear in
 * every subsequent system prompt.
 */
export async function reflectPersona(ctx: DreamContext): Promise<void> {
  const modelId = env.MEMORY_EXTRACT_MODEL ?? env.LLM_DEFAULT_MODEL;
  if (modelId === "disabled") return;

  const cutoff = new Date(ctx.now.getTime() - SLEEP_REFLECT_LOOKBACK_MS);

  const recent = await db
    .select({
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        gt(messages.createdAt, cutoff),
        ctx.guildId === null
          ? sql`1 = 1`
          : sql`${messages.conversationId} in (select id from conversations where guild_id = ${ctx.guildId})`,
        sql`${messages.content} is not null`
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(SLEEP_REFLECT_MAX_MESSAGES);

  if (recent.length < 10) {
    addStat(ctx, PHASE, "skippedLowSignal");
    return;
  }
  addStat(ctx, PHASE, "messagesConsidered", recent.length);

  // Load existing addenda in scope so the model avoids restating them.
  const existing = await db
    .select({ text: personaAddenda.text })
    .from(personaAddenda)
    .where(
      and(
        eq(personaAddenda.active, true),
        ctx.guildId === null
          ? sql`${personaAddenda.guildId} is null`
          : sql`(${personaAddenda.guildId} = ${ctx.guildId} or ${personaAddenda.guildId} is null)`
      )
    );

  const transcript = recent
    .slice()
    .reverse()
    .map((m) => `${m.role}: ${(m.content ?? "").slice(0, 400)}`)
    .join("\n");

  const existingList = existing.length
    ? `Existing durable notes (don't restate these):\n${existing.map((e) => `- ${e.text}`).join("\n")}`
    : "No existing durable notes.";

  let reflection: z.infer<typeof reflectionSchema>;
  try {
    const r = await generateObject({
      model: getLLMProvider(undefined, modelId),
      schema: reflectionSchema,
      prompt: [
        "You are the agent reflecting on recent conversations to grow durable self-knowledge.",
        "Propose at most 3 short notes about traits, habits, or patterns worth carrying forward. Avoid user-specific facts (those go elsewhere).",
        `Only include entries you are at least ${SLEEP_REFLECT_MIN_CONFIDENCE}% confident in. Prefer fewer, higher-confidence entries.`,
        "Avoid generic platitudes. Be specific about what the recent transcript actually shows.",
        "",
        existingList,
        "",
        "Recent transcript (oldest first):",
        transcript,
      ].join("\n"),
      maxRetries: 1,
    });
    reflection = r.object;
    ctx.tokenUsage +=
      (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
  } catch (err) {
    logger.warn("sleep: reflect-persona LLM failed", { err });
    return;
  }

  const qualified = reflection.addenda
    .filter((a) => a.confidence >= SLEEP_REFLECT_MIN_CONFIDENCE)
    .slice(0, SLEEP_REFLECT_MAX_ADDENDA_PER_RUN);

  if (qualified.length === 0) {
    addStat(ctx, PHASE, "noQualifying");
    return;
  }

  for (const a of qualified) {
    const changeId = await logChange({
      runId: ctx.runId,
      kind: "persona_addendum",
      targetTable: "persona_addenda",
      targetId: null,
      before: null,
      after: { text: a.text, reason: a.reason, confidence: a.confidence },
    });
    addStat(ctx, PHASE, "addendaLogged");

    if (ctx.dryRun) continue;

    const [inserted] = await db
      .insert(personaAddenda)
      .values({
        guildId: ctx.guildId,
        text: a.text,
        reason: a.reason,
        confidence: Math.round(a.confidence),
        sourceRunId: ctx.runId,
        active: true,
      })
      .returning({ id: personaAddenda.id });

    // patch the change row with the new id so rollback knows what to flip
    if (inserted && changeId != null) {
      await db
        .update(sleepCycleChanges)
        .set({ targetId: String(inserted.id) })
        .where(eq(sleepCycleChanges.id, changeId));
    }
    addStat(ctx, PHASE, "addendaWritten");
  }

  if (!ctx.dryRun && qualified.length > 0) {
    await refreshAddendaCache(ctx.guildId);
  }
}
