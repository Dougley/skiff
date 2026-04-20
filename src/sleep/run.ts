import { eq } from "drizzle-orm";
import { db, sleepCycleRuns, sleepCycleSettings } from "../db/index.js";
import { logger } from "../logger/index.js";
import type { DreamContext } from "./context.js";
import { consolidateFacts } from "./phases/consolidate-facts.js";
import { dedupeTopics } from "./phases/dedupe-topics.js";
import { proposeSkills } from "./phases/propose-skills.js";
import { reflectPersona } from "./phases/reflect-persona.js";
import { synthesizeTopics } from "./phases/synthesize-topics.js";

export type RunOptions = {
  guildId: string | null;
  triggerReason: "scheduled" | "manual" | "test";
  /** Override the guild's dryRun setting (used by `/sleep-cycle run-now --dry`). */
  forceDryRun?: boolean;
  /** Override the autoAuthorSkills gate. */
  forceAutoAuthorSkills?: boolean;
};

export type RunResult = {
  runId: number;
  status: "succeeded" | "failed";
  phaseStats: Record<string, Record<string, number>>;
  error?: string;
};

/**
 * Execute a single dream pass for one guild. Creates a run row, invokes each
 * phase, and finalizes status. Safe to call from both the scheduler loop and
 * the `/sleep-cycle run-now` command.
 */
export async function executeDreamPass(
  options: RunOptions
): Promise<RunResult> {
  const settings = options.guildId
    ? (
        await db
          .select()
          .from(sleepCycleSettings)
          .where(eq(sleepCycleSettings.guildId, options.guildId))
          .limit(1)
      )[0]
    : null;

  const dryRun =
    options.forceDryRun !== undefined
      ? options.forceDryRun
      : (settings?.dryRun ?? true);
  const autoAuthorSkills =
    options.forceAutoAuthorSkills !== undefined
      ? options.forceAutoAuthorSkills
      : (settings?.autoAuthorSkills ?? false);

  const [run] = await db
    .insert(sleepCycleRuns)
    .values({
      guildId: options.guildId,
      status: "running",
      dryRun,
      triggerReason: options.triggerReason,
    })
    .returning();

  if (!run) {
    throw new Error("sleep: failed to create run row");
  }

  const ctx: DreamContext = {
    runId: run.id,
    guildId: options.guildId,
    dryRun,
    phaseStats: {},
    now: new Date(),
  };

  logger.info("sleep: dream pass starting", {
    runId: run.id,
    guildId: options.guildId,
    dryRun,
    trigger: options.triggerReason,
  });

  try {
    await consolidateFacts(ctx);
    await dedupeTopics(ctx);
    await synthesizeTopics(ctx);
    await reflectPersona(ctx);
    if (autoAuthorSkills) {
      await proposeSkills(ctx);
    } else {
      ctx.phaseStats.propose_skills = { gatedOff: 1 };
    }

    await db
      .update(sleepCycleRuns)
      .set({
        status: "succeeded",
        finishedAt: new Date(),
        phaseStats: ctx.phaseStats,
      })
      .where(eq(sleepCycleRuns.id, run.id));

    logger.info("sleep: dream pass succeeded", {
      runId: run.id,
      stats: ctx.phaseStats,
    });

    return {
      runId: run.id,
      status: "succeeded",
      phaseStats: ctx.phaseStats,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("sleep: dream pass failed", { runId: run.id, err });
    await db
      .update(sleepCycleRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        phaseStats: ctx.phaseStats,
        error: message,
      })
      .where(eq(sleepCycleRuns.id, run.id));
    return {
      runId: run.id,
      status: "failed",
      phaseStats: ctx.phaseStats,
      error: message,
    };
  }
}
