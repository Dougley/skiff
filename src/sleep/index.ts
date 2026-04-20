import { and, count, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { db, messages, sleepCycleSettings } from "../db/index.js";
import { logger } from "../logger/index.js";
import { executeDreamPass } from "./run.js";

const TICK_INTERVAL_MS = 5 * 60 * 1000;
/** Sentinel date used to atomically claim eligible guilds. */
const CLAIM_SENTINEL = new Date("9999-01-01T00:00:00Z");
/** Minimum spacing between two runs for the same guild. */
const MIN_COOLDOWN_MS = 60 * 60 * 1000;

let tickHandle: ReturnType<typeof setInterval> | null = null;

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

    // Claim the eligible rows so overlapping ticks can't double-fire.
    await db
      .update(sleepCycleSettings)
      .set({ nextEligibleAt: CLAIM_SENTINEL })
      .where(
        inArray(
          sleepCycleSettings.guildId,
          toRun.map((s) => s.guildId)
        )
      );

    for (const s of toRun) {
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
  }
}

export { executeDreamPass } from "./run.js";
