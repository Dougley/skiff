import { tool } from "@ai-sdk/provider-utils";
import { z } from "zod";
import {
  createStoryline,
  getStoryline,
  listStorylines,
  recordStorylineEvent,
  resolveStorylineEvent,
  STORYLINE_EVENT_KINDS,
  STORYLINE_STATUSES,
} from "../logbook/store.js";
import type { DiscordToolContext } from "./discord.js";

const storylineStatusSchema = z.enum(STORYLINE_STATUSES);
const eventKindSchema = z.enum(STORYLINE_EVENT_KINDS);

export const createLogbookTools = (ctx: DiscordToolContext) => {
  const scope = { guildId: ctx.guildId, channelId: ctx.channelId };

  return {
    logbook_list: tool({
      description:
        "List the active Logbook storylines in this server or DM. Use this to recall ongoing goals, projects, decisions, and open loops.",
      inputSchema: z.object({
        includeClosed: z
          .boolean()
          .default(false)
          .describe("Include completed and abandoned storylines."),
      }),
      execute: async ({ includeClosed }) => {
        const rows = await listStorylines(
          scope,
          includeClosed ? [...STORYLINE_STATUSES] : ["open", "paused"]
        );
        return {
          storylines: rows.map((row) => ({
            id: row.id,
            title: row.title,
            goal: row.goal,
            currentState: row.currentState,
            status: row.status,
            owners: row.ownerUserIds,
            tags: row.tags,
            lastActivityAt: row.lastActivityAt.toISOString(),
          })),
        };
      },
    }),

    logbook_get: tool({
      description:
        "Read one Logbook storyline and its recent event history, including decisions, commitments, questions, and risks.",
      inputSchema: z.object({ storylineId: z.number().int().positive() }),
      execute: async ({ storylineId }) => {
        const result = await getStoryline(scope, storylineId);
        if (!result) return { error: "Storyline not found in this scope." };
        const storyline = result.storyline;
        return {
          storyline: {
            id: storyline.id,
            title: storyline.title,
            goal: storyline.goal,
            currentState: storyline.currentState,
            status: storyline.status,
            owners: storyline.ownerUserIds,
            tags: storyline.tags,
            lastActivityAt: storyline.lastActivityAt.toISOString(),
          },
          events: result.events.map((event) => ({
            ...event,
            dueAt: event.dueAt?.toISOString() ?? null,
            resolvedAt: event.resolvedAt?.toISOString() ?? null,
            createdAt: event.createdAt.toISOString(),
          })),
        };
      },
    }),

    logbook_create: tool({
      description:
        "Create a durable Logbook storyline when the user explicitly wants to track an ongoing goal, project, investigation, or shared endeavor. Do not create one merely because a topic was mentioned.",
      inputSchema: z.object({
        title: z.string().min(1).max(120),
        goal: z.string().min(1).max(1000),
        currentState: z.string().min(1).max(1500),
        ownerUserIds: z.array(z.string()).default([]),
        tags: z.array(z.string().max(40)).max(10).default([]),
      }),
      execute: async (input) => {
        const storyline = await createStoryline({
          ...scope,
          ...input,
          createdByUserId: ctx.userId ?? null,
          sourceMessageId: ctx.sourceMessageId ?? null,
        });
        return {
          success: true,
          storylineId: storyline.id,
          title: storyline.title,
          status: storyline.status,
        };
      },
    }),

    logbook_record: tool({
      description:
        "Append a development to an existing Logbook storyline. Use for explicit decisions, commitments, open questions, risks, milestones, and useful notes. Optionally replace the concise current-state summary or change lifecycle status.",
      inputSchema: z.object({
        storylineId: z.number().int().positive(),
        kind: eventKindSchema,
        summary: z.string().min(1).max(500),
        details: z.string().max(2000).nullable().default(null),
        ownerUserId: z.string().nullable().default(null),
        dueAt: z
          .string()
          .datetime({ offset: true })
          .nullable()
          .default(null)
          .describe("ISO 8601 deadline with timezone, when explicitly known."),
        currentState: z.string().max(1500).nullable().default(null),
        storylineStatus: storylineStatusSchema.nullable().default(null),
      }),
      execute: async ({ dueAt, ...input }) => {
        const result = await recordStorylineEvent({
          ...scope,
          ...input,
          dueAt: dueAt ? new Date(dueAt) : null,
          actorUserId: ctx.userId ?? null,
          sourceMessageId: ctx.sourceMessageId ?? null,
        });
        if (!result) return { error: "Storyline not found in this scope." };
        return {
          success: true,
          storylineId: result.storyline.id,
          eventId: result.event.id,
          status: result.storyline.status,
          currentState: result.storyline.currentState,
        };
      },
    }),

    logbook_resolve: tool({
      description:
        "Resolve an active Logbook question, commitment, or risk by event ID. Optionally record a short resolution note.",
      inputSchema: z.object({
        storylineId: z.number().int().positive(),
        eventId: z.number().int().positive(),
        resolution: z.string().max(1000).nullable().default(null),
      }),
      execute: async (input) => {
        const result = await resolveStorylineEvent({
          ...scope,
          ...input,
          actorUserId: ctx.userId ?? null,
          sourceMessageId: ctx.sourceMessageId ?? null,
        });
        if (!result) {
          return {
            error: "Active event or storyline not found in this scope.",
          };
        }
        return { success: true, resolvedEventId: result.resolved.id };
      },
    }),
  };
};
