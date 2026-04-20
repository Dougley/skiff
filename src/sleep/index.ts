import { and, count, eq, gt, lte, sql } from "drizzle-orm";
import { db, messages, sleepCycleSettings } from "../db/index.js";
import { logger } from "../logger/index.js";
import { executeDreamPass } from "./run.js";

const TICK_INTERVAL_MS = 5 * 60 * 1000;
/** Minimum spacing between two runs for the same guild. */
const MIN_COOLDOWN_MS = 60 * 60 * 1000;
/**
 * Lease window for a claimed guild. Short enough that a crashed process
 * self-heals within a cycle, long enough that a slow dream pass won't be
 * reclaimed underneath us.
 */
const CLAIM_LEASE_MS = 30 * 60 * 1000;

let tickHandle: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startSleepCycle(): void {
  if (tickHandle) return;
  logger.info("Sleep cycle scheduler started", {
    intervalMinutes: TICK_INTERVAL_MS / 60000,
  });
  void tick();
  tickHandle = setInterval(() => void tick(), TICK_INTERVAL_MS);
}

export function stopSleepCycle(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
    logger.info("Sleep cycle scheduler stopped");
  }
}

async function tick(): Promise<void> {
  if (ticking) {
    logger.debug("sleep: previous tick still running, skipping");
    return;
  }
  ticking = true;
  try {
    const now = new Date();

    const eligible = await db
      .select()
      .from(sleepCycleSettings)
      .where(
        and(
          eq(sleepCycleSettings.enabled, true),
          lte(sleepCycleSettings.nextEligibleAt, now)
        )
      );

    if (eligible.length === 0) return;

    const toRun: typeof eligible = [];

    for (const s of eligible) {
      // Activity gate: skip guilds whose channels have been active in the
      // recent window. We only run dream passes when the guild is quiet.
      const cutoff = new Date(now.getTime() - s.lowActivityMinutes * 60 * 1000);
      const [activity] = await db
        .select({ n: count() })
        .from(messages)
        .where(
          and(
            gt(messages.createdAt, cutoff),
            sql`${messages.conversationId} in (select id from conversations where guild_id = ${s.guildId})`
          )
        );
      const activeCount = activity?.n ?? 0;
      if (activeCount > s.minInactiveMessages) {
        logger.debug("sleep: guild still active, deferring", {
          guildId: s.guildId,
          activeCount,
          threshold: s.minInactiveMessages,
        });
        continue;
      }
      toRun.push(s);
    }

    if (toRun.length === 0) return;

    // Atomic claim: push each eligible row's nextEligibleAt out by a lease
    // window, but only if it's still eligible. `returning` tells us which
    // rows we actually won; a crashed process self-heals once the lease
    // expires instead of being stuck forever.
    const leaseUntil = new Date(now.getTime() + CLAIM_LEASE_MS);
    const claimedIds = new Set<string>();
    for (const s of toRun) {
      const rows = await db
        .update(sleepCycleSettings)
        .set({ nextEligibleAt: leaseUntil })
        .where(
          and(
            eq(sleepCycleSettings.guildId, s.guildId),
            eq(sleepCycleSettings.enabled, true),
            lte(sleepCycleSettings.nextEligibleAt, now)
          )
        )
        .returning({ guildId: sleepCycleSettings.guildId });
      if (rows[0]) claimedIds.add(rows[0].guildId);
    }

    if (claimedIds.size === 0) return;

    for (const s of toRun) {
      if (!claimedIds.has(s.guildId)) continue;
      try {
        await executeDreamPass({
          guildId: s.guildId,
          triggerReason: "scheduled",
        });
      } catch (err) {
        logger.warn("sleep: dream pass threw", { guildId: s.guildId, err });
      }

      const spacing = Math.max(
        Math.floor((24 * 60 * 60 * 1000) / s.maxRunsPerDay),
        MIN_COOLDOWN_MS
      );
      const next = new Date(Date.now() + spacing);
      await db
        .update(sleepCycleSettings)
        .set({
          lastRunAt: new Date(),
          nextEligibleAt: next,
          updatedAt: new Date(),
        })
        .where(eq(sleepCycleSettings.guildId, s.guildId));
    }
  } catch (err) {
    logger.error("sleep: tick failed", { err });
  } finally {
    ticking = false;
  }
}

export { executeDreamPass } from "./run.js";
