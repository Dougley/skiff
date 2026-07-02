import type { Client } from "discord.js";
import { and, eq, lte, sql } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { db, sleepCycleSettings } from "../../db/index.js";
import { executeDreamPass, type RunResult } from "./run.js";

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const MIN_COOLDOWN_MS = 60 * 60 * 1000;
const CLAIM_LEASE_MS = 30 * 60 * 1000;

let tickHandle: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startSleepCycle(client: Client): void {
  if (tickHandle) return;
  logger.info("Sleep cycle scheduler started", {
    intervalMinutes: TICK_INTERVAL_MS / 60000,
  });
  void tick(client);
  tickHandle = setInterval(() => void tick(client), TICK_INTERVAL_MS);
}

// digest of what a dream pass did, posted to the configured report channel.
// returns null for uneventful runs so quiet nights don't produce noise.
function formatDreamReport(result: RunResult): string | null {
  if (result.status === "failed") {
    return `🌙 Dream pass #${result.runId} failed: ${result.error ?? "unknown error"}`;
  }

  const n = (phase: string, key: string) =>
    result.phaseStats[phase]?.[key] ?? 0;
  const plural = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;

  const parts: string[] = [];
  const resolutions = n("consolidate_facts", "resolutions");
  if (resolutions)
    parts.push(`resolved ${plural(resolutions, "fact conflict")}`);
  const merges = n("dedupe_topics", "merges");
  if (merges) parts.push(`merged ${plural(merges, "duplicate topic")}`);
  const created = n("synthesize_topics", "topicsCreated");
  if (created) parts.push(`learned ${plural(created, "new topic")}`);
  const addenda =
    n("reflect_persona", "addendaWritten") ||
    n("reflect_persona", "addendaLogged");
  if (addenda) parts.push(`wrote ${plural(addenda, "persona note")}`);
  const skills =
    n("propose_skills", "skillsAuthored") ||
    n("propose_skills", "proposalsPending");
  if (skills) parts.push(`${plural(skills, "skill proposal")}`);

  if (parts.length === 0) return null;

  const dry = result.dryRun ? " (dry run — nothing applied)" : "";
  const lines = [
    `🌙 Dream pass #${result.runId}${dry}: ${parts.join(", ")}.`,
    `-# \`/sleep-cycle changes run-id:${result.runId}\` to review${result.dryRun ? "" : ` · \`/sleep-cycle rollback run-id:${result.runId}\` to revert`}`,
  ];
  return lines.join("\n");
}

async function sendDreamReport(
  client: Client,
  channelId: string,
  result: RunResult
): Promise<void> {
  const report = formatDreamReport(result);
  if (!report) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isSendable()) {
      logger.warn("sleep: report channel not sendable", { channelId });
      return;
    }
    await channel.send(report);
  } catch (err) {
    logger.warn("sleep: failed to send dream report", { channelId, err });
  }
}

export function stopSleepCycle(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
    logger.info("Sleep cycle scheduler stopped");
  }
}

async function tick(client: Client): Promise<void> {
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

    // Activity gate: skip guilds whose channels have been active in the
    // recent window. Compute per-guild counts in one query (grouped over a
    // VALUES table of (guildId, cutoff)) so this stays O(1) DB roundtrips
    // regardless of how many guilds opted in.
    const cutoffPairs = eligible.map(
      (s) =>
        sql`(${s.guildId}::text, to_timestamp(${Math.floor(
          (now.getTime() - s.lowActivityMinutes * 60 * 1000) / 1000
        )}))`
    );
    const valuesClause = sql.join(cutoffPairs, sql`, `);
    const activityResult = await db.execute(sql`
      select s.guild_id as "guildId",
             count(m.id)::int as "n"
      from (values ${valuesClause}) as s(guild_id, cutoff)
      left join conversations c on c.guild_id = s.guild_id
      left join messages m on m.conversation_id = c.id and m.created_at > s.cutoff
      group by s.guild_id
    `);
    const activityRows = (
      activityResult as unknown as { rows: { guildId: string; n: number }[] }
    ).rows;
    const counts = new Map<string, number>(
      activityRows.map((r) => [r.guildId, Number(r.n)])
    );

    const toRun: typeof eligible = [];
    for (const s of eligible) {
      const activeCount = counts.get(s.guildId) ?? 0;
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
        const result = await executeDreamPass({
          guildId: s.guildId,
          triggerReason: "scheduled",
        });
        if (s.reportChannelId) {
          await sendDreamReport(client, s.reportChannelId, result);
        }
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
