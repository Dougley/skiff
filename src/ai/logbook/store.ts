import { type Embedding, embed } from "ai";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import {
  db,
  type Storyline,
  type StorylineEvent,
  storylineEvents,
  storylines,
} from "../../db/index.js";
import { embeddingProvider } from "../llm/provider.js";
import {
  normalizeEmbeddingDimensions,
  toVectorLiteral,
} from "../memory/vector.js";

export const STORYLINE_STATUSES = [
  "open",
  "paused",
  "completed",
  "abandoned",
] as const;
export type StorylineStatus = (typeof STORYLINE_STATUSES)[number];

export const STORYLINE_EVENT_KINDS = [
  "note",
  "decision",
  "open_question",
  "commitment",
  "risk",
  "milestone",
] as const;
export type StorylineEventKind = (typeof STORYLINE_EVENT_KINDS)[number];

export type LogbookScope = {
  guildId: string | null;
  channelId: string;
};

export function storylineScopeFilter(scope: LogbookScope) {
  return scope.guildId
    ? eq(storylines.guildId, scope.guildId)
    : and(
        sql`${storylines.guildId} is null`,
        eq(storylines.channelId, scope.channelId)
      );
}

async function createStorylineEmbedding(input: {
  title: string;
  goal: string;
  currentState: string;
}): Promise<Embedding | null> {
  if (!embeddingProvider) return null;
  try {
    const result = await embed({
      model: embeddingProvider,
      value: `${input.title}\nGoal: ${input.goal}\nCurrent state: ${input.currentState}`,
    });
    return normalizeEmbeddingDimensions(result.embedding);
  } catch (err) {
    logger.warn("logbook embedding failed", { err });
    return null;
  }
}

export async function createStoryline(
  params: LogbookScope & {
    title: string;
    goal: string;
    currentState: string;
    createdByUserId?: string | null;
    ownerUserIds?: string[];
    tags?: string[];
    sourceMessageId?: number | null;
  }
): Promise<Storyline> {
  const embedding = await createStorylineEmbedding(params);
  const now = new Date();

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(storylines)
      .values({
        title: params.title.trim(),
        goal: params.goal.trim(),
        currentState: params.currentState.trim(),
        guildId: params.guildId,
        channelId: params.guildId ? null : params.channelId,
        createdByUserId: params.createdByUserId ?? null,
        ownerUserIds: [...new Set(params.ownerUserIds ?? [])],
        tags: [
          ...new Set(
            (params.tags ?? []).map((tag) => tag.trim()).filter(Boolean)
          ),
        ],
        sourceMessageId: params.sourceMessageId ?? null,
        embedding,
        lastActivityAt: now,
      })
      .returning();

    if (!created) throw new Error("Failed to create Logbook storyline");

    await tx.insert(storylineEvents).values({
      storylineId: created.id,
      kind: "milestone",
      summary: "Storyline created",
      details: created.currentState,
      actorUserId: params.createdByUserId ?? null,
      sourceMessageId: params.sourceMessageId ?? null,
    });
    return created;
  });
}

export async function listStorylines(
  scope: LogbookScope,
  statuses: StorylineStatus[] = ["open", "paused"],
  limit = 20
): Promise<Storyline[]> {
  return db
    .select()
    .from(storylines)
    .where(
      and(
        storylineScopeFilter(scope),
        statuses.length > 0 ? inArray(storylines.status, statuses) : undefined
      )
    )
    .orderBy(desc(storylines.lastActivityAt))
    .limit(limit);
}

export async function getStoryline(
  scope: LogbookScope,
  storylineId: number,
  eventLimit = 20
): Promise<{ storyline: Storyline; events: StorylineEvent[] } | null> {
  const [storyline] = await db
    .select()
    .from(storylines)
    .where(and(eq(storylines.id, storylineId), storylineScopeFilter(scope)))
    .limit(1);
  if (!storyline) return null;

  const events = await db
    .select()
    .from(storylineEvents)
    .where(eq(storylineEvents.storylineId, storylineId))
    .orderBy(desc(storylineEvents.createdAt))
    .limit(eventLimit);
  return { storyline, events };
}

export async function recordStorylineEvent(
  params: LogbookScope & {
    storylineId: number;
    kind: StorylineEventKind;
    summary: string;
    details?: string | null;
    actorUserId?: string | null;
    ownerUserId?: string | null;
    dueAt?: Date | null;
    sourceMessageId?: number | null;
    currentState?: string | null;
    storylineStatus?: StorylineStatus | null;
  }
): Promise<{ storyline: Storyline; event: StorylineEvent } | null> {
  const existing = await getStoryline(params, params.storylineId, 0);
  if (!existing) return null;

  const nextState =
    params.currentState?.trim() || existing.storyline.currentState;
  const embedding = params.currentState
    ? await createStorylineEmbedding({
        title: existing.storyline.title,
        goal: existing.storyline.goal,
        currentState: nextState,
      })
    : existing.storyline.embedding;
  const now = new Date();

  return db.transaction(async (tx) => {
    const [event] = await tx
      .insert(storylineEvents)
      .values({
        storylineId: params.storylineId,
        kind: params.kind,
        summary: params.summary.trim(),
        details: params.details?.trim() || null,
        actorUserId: params.actorUserId ?? null,
        ownerUserId: params.ownerUserId ?? null,
        dueAt: params.dueAt ?? null,
        sourceMessageId: params.sourceMessageId ?? null,
      })
      .returning();
    if (!event) throw new Error("Failed to record Logbook event");

    const [storyline] = await tx
      .update(storylines)
      .set({
        currentState: nextState,
        status: params.storylineStatus ?? existing.storyline.status,
        embedding,
        lastActivityAt: now,
        updatedAt: now,
      })
      .where(eq(storylines.id, params.storylineId))
      .returning();
    if (!storyline) throw new Error("Failed to update Logbook storyline");
    return { storyline, event };
  });
}

export async function resolveStorylineEvent(
  params: LogbookScope & {
    storylineId: number;
    eventId: number;
    actorUserId?: string | null;
    resolution?: string | null;
    sourceMessageId?: number | null;
  }
): Promise<{
  resolved: StorylineEvent;
  resolution: StorylineEvent | null;
} | null> {
  const existing = await getStoryline(params, params.storylineId, 0);
  if (!existing) return null;
  const now = new Date();

  return db.transaction(async (tx) => {
    const [resolved] = await tx
      .update(storylineEvents)
      .set({ status: "resolved", resolvedAt: now })
      .where(
        and(
          eq(storylineEvents.id, params.eventId),
          eq(storylineEvents.storylineId, params.storylineId),
          eq(storylineEvents.status, "active"),
          inArray(storylineEvents.kind, ["open_question", "commitment", "risk"])
        )
      )
      .returning();
    if (!resolved) return null;

    let resolution: StorylineEvent | null = null;
    if (params.resolution?.trim()) {
      const [insertedResolution] = await tx
        .insert(storylineEvents)
        .values({
          storylineId: params.storylineId,
          kind: "note",
          summary: params.resolution.trim(),
          details: `Resolved event #${params.eventId}: ${resolved.summary}`,
          actorUserId: params.actorUserId ?? null,
          sourceMessageId: params.sourceMessageId ?? null,
        })
        .returning();
      resolution = insertedResolution ?? null;
    }

    await tx
      .update(storylines)
      .set({ lastActivityAt: now, updatedAt: now })
      .where(eq(storylines.id, params.storylineId));
    return { resolved, resolution };
  });
}

const QUERY_STOP_WORDS = new Set([
  "and",
  "are",
  "for",
  "from",
  "has",
  "have",
  "how",
  "its",
  "the",
  "this",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
]);

function queryTerms(query: string): string[] {
  return [
    ...new Set(
      (query.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter(
        (term) => !QUERY_STOP_WORDS.has(term)
      )
    ),
  ].slice(0, 20);
}

/** Retrieve active storylines relevant to a new message for prompt continuity. */
export async function findRelevantStorylines(
  scope: LogbookScope,
  query: string,
  limit = 3
): Promise<Storyline[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];

  if (embeddingProvider) {
    try {
      const result = await embed({ model: embeddingProvider, value: trimmed });
      const vector = sql`${toVectorLiteral(normalizeEmbeddingDimensions(result.embedding))}::vector`;
      const distance = sql<number>`(${storylines.embedding} <=> ${vector})`;
      const rows = await db
        .select({ row: storylines, distance })
        .from(storylines)
        .where(
          and(
            storylineScopeFilter(scope),
            inArray(storylines.status, ["open", "paused"]),
            sql`${storylines.embedding} is not null`,
            sql`${distance} <= 0.7`
          )
        )
        .orderBy(distance)
        .limit(limit);
      if (rows.length > 0) return rows.map(({ row }) => row);
    } catch (err) {
      logger.warn("logbook relevance search failed; using lexical fallback", {
        err,
      });
    }
  }

  const terms = queryTerms(trimmed);
  if (terms.length === 0) return [];
  const candidates = await listStorylines(scope, ["open", "paused"], 30);
  return candidates
    .map((row) => {
      const title = row.title.toLowerCase();
      const body =
        `${row.goal} ${row.currentState} ${row.tags.join(" ")}`.toLowerCase();
      const score = terms.reduce(
        (sum, term) =>
          sum + (title.includes(term) ? 3 : body.includes(term) ? 1 : 0),
        0
      );
      return { row, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row }) => row);
}

export function formatStorylinesForPrompt(rows: Storyline[]): string[] {
  return rows.map(
    (row) =>
      `#${row.id} ${row.title} [${row.status}] — Goal: ${row.goal} Current state: ${row.currentState}`
  );
}
