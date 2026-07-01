import type { Client } from "discord.js";
import { MessageFlags } from "discord.js";
import { and, eq, inArray, lte } from "drizzle-orm";
import { handleConversationTurn } from "../../ai/llm/conversation-turn.js";
import { logger } from "../../config/logger.js";
import { db, type ScheduledTask, scheduledTasks } from "../../db/index.js";
import { getNextCronDate } from "./cron.js";

const TICK_INTERVAL_MS = 30_000;

/** Sentinel date far in the future used to atomically claim due tasks. */
const CLAIM_SENTINEL = new Date("9999-01-01T00:00:00Z");

let tickHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the scheduler loop. Call once after the Discord client is ready.
 * Immediately runs a catch-up tick for any tasks missed while offline.
 */
export function startScheduler(client: Client): void {
  if (tickHandle) return;
  logger.info("Scheduler started");
  void reclaimStuckTasks().then(() => tick(client));
  tickHandle = setInterval(() => void tick(client), TICK_INTERVAL_MS);
}

/**
 * Reset tasks left claimed at the sentinel by a crash between claim and
 * reschedule — without this they would never become due again.
 */
async function reclaimStuckTasks(): Promise<void> {
  try {
    const reclaimed = await db
      .update(scheduledTasks)
      .set({ nextRunAt: new Date() })
      .where(
        and(
          eq(scheduledTasks.enabled, true),
          eq(scheduledTasks.nextRunAt, CLAIM_SENTINEL)
        )
      )
      .returning({ id: scheduledTasks.id });
    if (reclaimed.length > 0) {
      logger.warn("Scheduler: reclaimed tasks stuck at claim sentinel", {
        taskIds: reclaimed.map((t) => t.id),
      });
    }
  } catch (err) {
    logger.error("Scheduler: failed to reclaim stuck tasks", { err });
  }
}

export function stopScheduler(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
    logger.info("Scheduler stopped");
  }
}

async function tick(client: Client): Promise<void> {
  try {
    const now = new Date();

    // snapshot due tasks first — we need the original nextRunAt to anchor
    // the next cron run (prevents drift). the sentinel is set in a second
    // query keyed by id, so atomicity within a single process is preserved.
    const dueTasks = await db
      .select()
      .from(scheduledTasks)
      .where(
        and(
          eq(scheduledTasks.enabled, true),
          lte(scheduledTasks.nextRunAt, now)
        )
      );

    if (dueTasks.length === 0) return;

    // claim all due tasks so overlapping ticks can't fire the same task
    await db
      .update(scheduledTasks)
      .set({ nextRunAt: CLAIM_SENTINEL })
      .where(
        inArray(
          scheduledTasks.id,
          dueTasks.map((t) => t.id)
        )
      );

    for (const task of dueTasks) {
      await fireTask(client, task, task.nextRunAt); // original scheduled time
    }
  } catch (err) {
    logger.error("Scheduler tick error", { err });
  }
}

async function fireTask(
  client: Client,
  task: ScheduledTask,
  originalNextRunAt: Date
): Promise<void> {
  try {
    const channel = await client.channels.fetch(task.channelId);
    if (!channel?.isSendable()) {
      logger.warn("Scheduler: channel not sendable", {
        taskId: task.id,
        channelId: task.channelId,
      });
      // Still update the task to avoid repeated failures
      await updateTaskAfterFire(task, originalNextRunAt);
      return;
    }

    // Build the instruction prompt
    const label = task.cronExpression ? "Scheduled Task" : "Reminder";
    const prompt = `[${label}: ${task.name}]\n\n${task.instruction}`;

    logger.debug("Scheduler: running LLM turn for task", {
      taskId: task.id,
      name: task.name,
    });

    // Run full LLM turn
    const result = await handleConversationTurn({
      content: prompt,
      userId: client.user?.id ?? "system", // Use bot ID as "user"
      channelId: task.channelId,
      guildId: task.guildId,
      toolContext: {
        client,
        guildId: task.guildId,
        channelId: task.channelId,
        userId: null,
      },
      messageContext: {
        displayName: "Scheduled Task",
        username: "system",
        channelName: "name" in channel ? `#${channel.name}` : "DM",
        guildName:
          task.guildId && "guild" in channel
            ? (channel.guild?.name ?? null)
            : null,
        isDM: channel.isDMBased(),
      },
      skipInitialStatus: true,
      skipMemory: true,
    });

    // Send response to channel
    for (const msg of result.messages) {
      await channel.send({
        flags: MessageFlags.IsComponentsV2,
        components: msg.components,
        files: msg.files,
      });
    }

    logger.info("Scheduler: completed task", {
      taskId: task.id,
      name: task.name,
      usedTools: result.usedTools,
    });
  } catch (err) {
    logger.warn("Scheduler: failed to execute task", { taskId: task.id, err });
  }

  // Update: compute next run for recurring, or disable one-shots
  await updateTaskAfterFire(task, originalNextRunAt);
}

async function updateTaskAfterFire(
  task: ScheduledTask,
  originalNextRunAt: Date
): Promise<void> {
  const now = new Date();

  if (task.cronExpression) {
    // Anchor from the original nextRunAt to prevent schedule drift
    const nextRun = getNextCronDate(
      task.cronExpression,
      originalNextRunAt,
      task.timezone
    );
    if (nextRun) {
      await db
        .update(scheduledTasks)
        .set({ lastRunAt: now, nextRunAt: nextRun })
        .where(eq(scheduledTasks.id, task.id));
    } else {
      await db
        .update(scheduledTasks)
        .set({ enabled: false, lastRunAt: now })
        .where(eq(scheduledTasks.id, task.id));
    }
  } else {
    await db
      .update(scheduledTasks)
      .set({ enabled: false, lastRunAt: now })
      .where(eq(scheduledTasks.id, task.id));
  }
}
