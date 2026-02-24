import { tool } from "ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, scheduledTasks } from "../db/index.js";
import { getNextCronDate, isValidCron } from "../scheduler/cron.js";
import type { DiscordToolContext } from "./discord.js";

export const createSchedulerTools = (ctx: DiscordToolContext) => ({
  schedule_task: tool({
    description:
      "Schedule a task: either a one-shot reminder at a specific time, or a recurring task using a cron expression. " +
      "When the task fires, it will trigger a conversation turn where I'll follow the given instruction. " +
      "Provide exactly one of runAt (ISO 8601 datetime) or cronExpression (5-field cron).",
    inputSchema: z.object({
      name: z.string().min(1).max(100).describe("Short label for the task."),
      instruction: z
        .string()
        .min(1)
        .max(2000)
        .describe(
          "Instruction for what to do when the task fires (e.g., 'Check email and summarize new messages')."
        ),
      runAt: z
        .string()
        .nullable()
        .default(null)
        .describe(
          "ISO 8601 datetime for a one-shot reminder (e.g. '2026-02-21T15:00:00Z'). Mutually exclusive with cronExpression."
        ),
      cronExpression: z
        .string()
        .nullable()
        .default(null)
        .describe(
          "Cron expression for recurring tasks (5 fields: minute hour day-of-month month day-of-week). " +
            "Examples: '*/5 * * * *' (every 5 min), '0 9 * * 1-5' (9am weekdays). Mutually exclusive with runAt."
        ),
      timezone: z
        .string()
        .default("UTC")
        .describe(
          "IANA timezone for the cron expression (e.g. 'America/New_York', 'Europe/Amsterdam'). " +
            "Defaults to UTC. Only applies to cronExpression, not runAt."
        ),
    }),
    execute: async ({ name, instruction, runAt, cronExpression, timezone }) => {
      if ((!runAt && !cronExpression) || (runAt && cronExpression)) {
        return {
          error:
            "Provide exactly one of 'runAt' (one-shot) or 'cronExpression' (recurring).",
        };
      }

      let nextRunAt: Date;

      if (cronExpression) {
        if (!isValidCron(cronExpression)) {
          return {
            error: `Invalid cron expression: "${cronExpression}". Use 5-field format: minute hour day-of-month month day-of-week.`,
          };
        }
        const next = getNextCronDate(cronExpression, new Date(), timezone);
        if (!next) {
          return {
            error: "Could not compute next run time from the cron expression.",
          };
        }
        nextRunAt = next;
      } else {
        nextRunAt = new Date(runAt as string);
        if (Number.isNaN(nextRunAt.getTime())) {
          return {
            error: `Invalid date: "${runAt}". Use ISO 8601 format (e.g. 2026-02-21T15:00:00Z).`,
          };
        }
        if (nextRunAt.getTime() <= Date.now()) {
          return { error: "That time is in the past." };
        }
      }

      const [inserted] = await db
        .insert(scheduledTasks)
        .values({
          guildId: ctx.guildId,
          channelId: ctx.channelId,
          createdByUserId: ctx.userId ?? "unknown",
          name,
          instruction,
          cronExpression: cronExpression ?? undefined,
          timezone,
          nextRunAt,
        })
        .returning();

      if (!inserted) {
        return { error: "Failed to create task." };
      }

      return {
        id: inserted.id,
        name: inserted.name,
        nextRunAt: inserted.nextRunAt.toISOString(),
        recurring: !!cronExpression,
        instruction: inserted.instruction,
      };
    },
  }),

  list_tasks: tool({
    description:
      "List scheduled tasks for the current channel. Shows active tasks by default. " +
      "Limited to 10 tasks at a time. Use the 'index' parameter to see later pages.",
    inputSchema: z.object({
      includeDisabled: z
        .boolean()
        .default(false)
        .describe("If true, also show completed/disabled tasks."),
      index: z
        .number()
        .int()
        .positive()
        .nullable()
        .default(null)
        .describe(
          "Optional pagination index (1-based). Shows 10 tasks per page."
        ),
    }),
    execute: async ({ includeDisabled, index }) => {
      const conditions = [eq(scheduledTasks.channelId, ctx.channelId)];
      if (!includeDisabled) {
        conditions.push(eq(scheduledTasks.enabled, true));
      }

      const tasks = await db
        .select()
        .from(scheduledTasks)
        .limit(10)
        .offset(index && index > 1 ? (index - 1) * 10 : 0)
        .where(and(...conditions));

      if (tasks.length === 0) {
        return {
          tasks: [],
          message: "No (more) scheduled tasks in this channel.",
        };
      }

      return {
        tasks: tasks.map((t) => ({
          id: t.id,
          name: t.name,
          instruction:
            t.instruction.length > 100
              ? `${t.instruction.slice(0, 100)}...`
              : t.instruction,
          cronExpression: t.cronExpression,
          timezone: t.timezone,
          nextRunAt: t.nextRunAt.toISOString(),
          lastRunAt: t.lastRunAt?.toISOString() ?? null,
          enabled: t.enabled,
          createdBy: t.createdByUserId,
        })),
      };
    },
  }),

  cancel_task: tool({
    description:
      "Cancel a scheduled task by its ID. Users can only cancel their own tasks.",
    inputSchema: z.object({
      taskId: z.number().int().describe("The ID of the task to cancel."),
    }),
    execute: async ({ taskId }) => {
      const conditions = [
        eq(scheduledTasks.id, taskId),
        eq(scheduledTasks.channelId, ctx.channelId),
      ];

      // Enforce per-user ownership when we know who's calling
      if (ctx.userId) {
        conditions.push(eq(scheduledTasks.createdByUserId, ctx.userId));
      }

      const [updated] = await db
        .update(scheduledTasks)
        .set({ enabled: false })
        .where(and(...conditions))
        .returning();

      if (!updated) {
        return {
          error: `Task #${taskId} not found in this channel, or you don't own it.`,
        };
      }

      return { success: true, id: updated.id, name: updated.name };
    },
  }),
});
