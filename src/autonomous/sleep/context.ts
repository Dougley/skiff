import { logger } from "../../config/logger.js";
import { db, sleepCycleChanges } from "../../db/index.js";

export type DreamContext = {
  runId: number;
  /** Guild scope; null for DM-scoped or legacy-global runs. */
  guildId: string | null;
  /** DM channel scope; set only for DM-scoped runs. */
  channelId: string | null;
  dryRun: boolean;
  phaseStats: Record<string, Record<string, number>>;
  tokenUsage: number;
  now: Date;
};

export type ChangeKind =
  | "persona_addendum"
  | "topic_merge"
  | "topic_new"
  | "fact_resolve"
  | "skill_author";

/**
 * Log a single change to sleep_cycle_changes. Every mutation a phase performs
 * should be accompanied by one of these rows so rollback is a single update.
 */
export async function logChange(params: {
  runId: number;
  kind: ChangeKind;
  targetTable?: string | null;
  targetId?: string | number | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}): Promise<number | null> {
  try {
    const [row] = await db
      .insert(sleepCycleChanges)
      .values({
        runId: params.runId,
        kind: params.kind,
        targetTable: params.targetTable ?? null,
        targetId: params.targetId != null ? String(params.targetId) : null,
        before: params.before ?? null,
        after: params.after ?? null,
      })
      .returning({ id: sleepCycleChanges.id });
    return row?.id ?? null;
  } catch (err) {
    logger.warn("sleep: logChange failed", {
      runId: params.runId,
      kind: params.kind,
      err,
    });
    return null;
  }
}

export function addStat(
  ctx: DreamContext,
  phase: string,
  key: string,
  delta = 1
): void {
  let bucket = ctx.phaseStats[phase];
  if (!bucket) {
    bucket = {};
    ctx.phaseStats[phase] = bucket;
  }
  bucket[key] = (bucket[key] ?? 0) + delta;
}
