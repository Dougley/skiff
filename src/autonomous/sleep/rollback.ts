import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { and, asc, eq, inArray } from "drizzle-orm";
import { reloadSkills } from "../../ai/skills/index.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import {
  db,
  personaAddenda,
  sleepCycleChanges,
  topicKnowledge,
  userFacts,
} from "../../db/index.js";
import { refreshAddendaCache } from "./addenda.js";

function isInsideSkillsDir(target: string): boolean {
  const skillsRoot = resolve(env.SKILLS_DIR);
  const resolved = resolve(target);
  if (resolved === skillsRoot) return false;
  return (
    resolved.startsWith(`${skillsRoot}${sep}`) ||
    resolved.startsWith(`${skillsRoot}/`)
  );
}

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
      const before = change.before as {
        retireIds?: number[];
        keepId?: number;
      } | null;
      const retireIds = before?.retireIds;
      const keepId = before?.keepId;
      if (!retireIds || retireIds.length === 0 || keepId === undefined) {
        return false;
      }
      // Only flip rows that are still superseded by the same keepId we
      // retired them under. If a later run resolved them again under a
      // different canonical, leave them alone — otherwise we'd resurrect
      // stale state.
      const updated = await db
        .update(userFacts)
        .set({
          active: true,
          supersededBy: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            inArray(userFacts.id, retireIds),
            eq(userFacts.active, false),
            eq(userFacts.supersededBy, keepId)
          )
        )
        .returning({ id: userFacts.id });
      if (updated.length === 0) return false;
      if (updated.length < retireIds.length) {
        logger.info(
          "sleep rollback: fact_resolve partially reverted (some facts moved)",
          {
            requested: retireIds.length,
            actual: updated.length,
            keepId,
          }
        );
      }
      return true;
    }
    case "topic_merge": {
      if (!targetId) return false;
      const before = change.before as {
        loser?: { id: number; summary?: string };
        canonical?: { id: number; summary?: string; tags?: string[] };
      } | null;
      const after = change.after as {
        mergedSummary?: string;
        mergedTags?: string[];
      } | null;
      const loser = before?.loser;
      const canonical = before?.canonical;
      if (!loser || !canonical) return false;
      let didAnything = false;
      await db.transaction(async (tx) => {
        // Only restore canonical fields if they still hold the values we set
        // during the merge — otherwise a later run has updated them and we'd
        // clobber newer state.
        const restore: {
          summary?: string;
          tags?: string[];
          updatedAt: Date;
        } = { updatedAt: new Date() };
        if (canonical.summary) restore.summary = canonical.summary;
        if (canonical.tags) restore.tags = canonical.tags;
        if (restore.summary || restore.tags) {
          const conds = [eq(topicKnowledge.id, canonical.id)];
          if (after?.mergedSummary) {
            conds.push(eq(topicKnowledge.summary, after.mergedSummary));
          }
          const restored = await tx
            .update(topicKnowledge)
            .set(restore)
            .where(and(...conds))
            .returning({ id: topicKnowledge.id });
          if (restored.length > 0) didAnything = true;
        }
        // Only reactivate the loser if it's still inactive AND superseded by
        // the canonical we set.
        const loserUpdated = await tx
          .update(topicKnowledge)
          .set({
            active: true,
            supersededBy: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(topicKnowledge.id, loser.id),
              eq(topicKnowledge.active, false),
              eq(topicKnowledge.supersededBy, canonical.id)
            )
          )
          .returning({ id: topicKnowledge.id });
        if (loserUpdated.length > 0) didAnything = true;
      });
      return didAnything;
    }
    case "topic_new": {
      if (!targetId) return false;
      const updated = await db
        .update(topicKnowledge)
        .set({ active: false, updatedAt: new Date() })
        .where(
          and(
            eq(topicKnowledge.id, Number(targetId)),
            eq(topicKnowledge.active, true)
          )
        )
        .returning({ id: topicKnowledge.id });
      return updated.length > 0;
    }
    case "persona_addendum": {
      if (!targetId) return false;
      const updated = await db
        .update(personaAddenda)
        .set({ active: false, retiredAt: new Date() })
        .where(
          and(
            eq(personaAddenda.id, Number(targetId)),
            eq(personaAddenda.active, true)
          )
        )
        .returning({ id: personaAddenda.id });
      return updated.length > 0;
    }
    case "skill_author": {
      if (!targetId) return false;
      if (!isInsideSkillsDir(targetId)) {
        logger.warn(
          "sleep rollback: skill path outside SKILLS_DIR, refusing to delete",
          { targetId, skillsDir: env.SKILLS_DIR }
        );
        return false;
      }
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
    .where(eq(sleepCycleChanges.runId, runId))
    .orderBy(asc(sleepCycleChanges.id));
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
