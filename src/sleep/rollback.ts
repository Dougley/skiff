import { rm } from "node:fs/promises";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  personaAddenda,
  sleepCycleChanges,
  topicKnowledge,
  userFacts,
} from "../db/index.js";
import { env } from "../env/index.js";
import { logger } from "../logger/index.js";
import { reloadSkills } from "../skills/index.js";
import { refreshAddendaCache } from "./addenda.js";

export type RollbackResult = {
  reverted: number;
  skipped: number;
  errors: string[];
};

/**
 * Revert a single change by id. Flips supersessions back, deactivates
 * created addenda, and deletes authored skill directories.
 */
async function revertChange(
  change: typeof sleepCycleChanges.$inferSelect
): Promise<boolean> {
  if (change.reverted) return false;

  const targetId = change.targetId;
  switch (change.kind) {
    case "fact_resolve": {
      const retireIds = (change.before as { retireIds?: number[] })?.retireIds;
      if (!retireIds || retireIds.length === 0) return false;
      await db
        .update(userFacts)
        .set({
          active: true,
          supersededBy: null,
          updatedAt: new Date(),
        })
        .where(inArray(userFacts.id, retireIds));
      return true;
    }
    case "topic_merge": {
      // Two cases: pair merge (has targetId) or new topic (targetId=null).
      if (!targetId) {
        // New-topic creation — no direct undo (we don't know which row was
        // inserted without more tracking). Best-effort: do nothing.
        return false;
      }
      const loser = (
        change.before as {
          loser?: { id: number; summary?: string };
        }
      )?.loser;
      const canonical = (
        change.before as {
          canonical?: { id: number; summary?: string };
        }
      )?.canonical;
      if (!loser || !canonical) return false;
      await db.transaction(async (tx) => {
        if (canonical.summary) {
          await tx
            .update(topicKnowledge)
            .set({ summary: canonical.summary, updatedAt: new Date() })
            .where(eq(topicKnowledge.id, canonical.id));
        }
        await tx
          .update(topicKnowledge)
          .set({
            active: true,
            supersededBy: null,
            updatedAt: new Date(),
          })
          .where(eq(topicKnowledge.id, loser.id));
      });
      return true;
    }
    case "persona_addendum": {
      if (!targetId) return false;
      await db
        .update(personaAddenda)
        .set({ active: false, retiredAt: new Date() })
        .where(eq(personaAddenda.id, Number(targetId)));
      return true;
    }
    case "skill_author": {
      if (!targetId) return false;
      try {
        await rm(targetId, { recursive: true, force: true });
        await reloadSkills(env.SKILLS_DIR);
      } catch (err) {
        logger.warn("sleep rollback: failed to remove skill dir", {
          dir: targetId,
          err,
        });
        return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/** Revert a single change row by id. */
export async function rollbackChange(
  changeId: number
): Promise<RollbackResult> {
  const [row] = await db
    .select()
    .from(sleepCycleChanges)
    .where(eq(sleepCycleChanges.id, changeId))
    .limit(1);
  if (!row) {
    return {
      reverted: 0,
      skipped: 0,
      errors: [`change ${changeId} not found`],
    };
  }
  return rollbackChanges([row]);
}

/** Revert every change in a run (oldest first). */
export async function rollbackRun(runId: number): Promise<RollbackResult> {
  const rows = await db
    .select()
    .from(sleepCycleChanges)
    .where(eq(sleepCycleChanges.runId, runId));
  return rollbackChanges(rows);
}

async function rollbackChanges(
  rows: (typeof sleepCycleChanges.$inferSelect)[]
): Promise<RollbackResult> {
  const result: RollbackResult = { reverted: 0, skipped: 0, errors: [] };
  let touchedAddendum = false;

  for (const row of rows) {
    if (row.reverted) {
      result.skipped++;
      continue;
    }
    try {
      const ok = await revertChange(row);
      if (!ok) {
        result.skipped++;
        continue;
      }
      await db
        .update(sleepCycleChanges)
        .set({ reverted: true })
        .where(eq(sleepCycleChanges.id, row.id));
      result.reverted++;
      if (row.kind === "persona_addendum") touchedAddendum = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("sleep rollback: change failed", { id: row.id, err });
      result.errors.push(`change ${row.id}: ${msg}`);
    }
  }

  if (touchedAddendum) {
    await refreshAddendaCache();
  }

  return result;
}
