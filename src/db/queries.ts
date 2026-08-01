import type { ToolCallPart, ToolContent } from "@ai-sdk/provider-utils";
import { and, desc, eq, gt, isNotNull, isNull, lt, or } from "drizzle-orm";
import { env } from "../config/env.js";
import { conversations, db, heartbeatChannels, messages } from "./index.js";
import type { Conversation, DBMessage } from "./schema.js";

export type ConversationLookup = {
  channelId: string;
  guildId: string | null;
  model?: string;
  systemPrompt?: string | null;
};

export async function getOrCreateConversation(
  input: ConversationLookup
): Promise<Conversation> {
  const upserted = await db
    .insert(conversations)
    .values({
      channelId: input.channelId,
      guildId: input.guildId ?? null,
      model: input.model ?? env.LLM_DEFAULT_MODEL,
      systemPrompt: input.systemPrompt ?? null,
    })
    .onConflictDoUpdate({
      target: [conversations.channelId, conversations.guildId],
      set: { updatedAt: new Date() },
    })
    .returning();

  if (!upserted[0]) throw new Error("Failed to create conversation");
  return upserted[0];
}

// matches the (channel_id, guild_id) unique index, which treats nulls as equal
function conversationKey(channelId: string, guildId: string | null) {
  return and(
    eq(conversations.channelId, channelId),
    guildId ? eq(conversations.guildId, guildId) : isNull(conversations.guildId)
  );
}

/** Read a conversation without creating one. Null when the channel has no history yet. */
export async function getConversation(params: {
  channelId: string;
  guildId: string | null;
}): Promise<Conversation | null> {
  const rows = await db
    .select()
    .from(conversations)
    .where(conversationKey(params.channelId, params.guildId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Set (or clear, with null) this channel's runtime model override. Creates the
 * conversation row when the channel hasn't been used yet, so `/model` works
 * before the first message.
 */
export async function setConversationModelOverride(params: {
  channelId: string;
  guildId: string | null;
  model: string | null;
}): Promise<void> {
  await db
    .insert(conversations)
    .values({
      channelId: params.channelId,
      guildId: params.guildId ?? null,
      // `model` records what the conversation was created under and stays
      // historical — the runtime selection lives in modelOverride
      model: env.LLM_DEFAULT_MODEL,
      modelOverride: params.model,
    })
    .onConflictDoUpdate({
      target: [conversations.channelId, conversations.guildId],
      set: { modelOverride: params.model, updatedAt: new Date() },
    });
}

export type MessageInsert = {
  conversationId: string;
  role: string;
  content: string | null;
  userId?: string | null;
  toolCalls?: ToolCallPart[] | null;
  toolResults?: ToolContent | null;
  lastInputTokens?: number | null;
};

export async function insertMessage(input: MessageInsert): Promise<DBMessage> {
  const inserted = await db
    .insert(messages)
    .values({
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      userId: input.userId ?? null,
      toolCalls: input.toolCalls ?? null,
      toolResults: input.toolResults ?? null,
      lastInputTokens: input.lastInputTokens ?? null,
    })
    .returning();

  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, input.conversationId));

  if (!inserted[0]) throw new Error("Failed to insert message");
  return inserted[0];
}

// fetch recent messages for a conversation, ordered oldest-first
// includes user/assistant text, assistant tool calls, and tool results.
// pass afterMessageId to exclude rows already folded into the compaction
// summary (conversations.summary_up_to_message_id)
export async function getRecentMessages(
  conversationId: string,
  limit?: number,
  afterMessageId?: number | null,
  beforeMessageId?: number | null
): Promise<
  Pick<DBMessage, "role" | "content" | "toolCalls" | "toolResults">[]
> {
  const rows = await db
    .select({
      role: messages.role,
      content: messages.content,
      toolCalls: messages.toolCalls,
      toolResults: messages.toolResults,
    })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        afterMessageId ? gt(messages.id, afterMessageId) : undefined,
        beforeMessageId ? lt(messages.id, beforeMessageId) : undefined,
        or(
          isNotNull(messages.content),
          isNotNull(messages.toolCalls),
          isNotNull(messages.toolResults)
        )
      )
    )
    .orderBy(desc(messages.id))
    .limit(limit ?? env.RAG_RECENT_LIMIT);

  const ordered = rows.reverse();

  // drop leading tool results whose assistant tool-call row fell outside the
  // window — providers reject a history that opens with an orphaned tool message
  while (ordered.length > 0 && ordered[0]?.role === "tool") {
    ordered.shift();
  }

  return ordered;
}

// most recent provider-reported input tokens for this conversation, or null if none
export async function getLastAssistantInputTokens(
  conversationId: string
): Promise<number | null> {
  const [row] = await db
    .select({ lastInputTokens: messages.lastInputTokens })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        isNotNull(messages.lastInputTokens)
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);

  return row?.lastInputTokens ?? null;
}

/**
 * Delete a conversation and all its messages/embeddings (via cascade).
 * Returns true if a conversation was found and deleted.
 *
 * A `/model` selection survives: clearing is about history, not settings, so
 * the override is carried onto a fresh row rather than silently reverting the
 * channel to the default.
 */
export async function deleteConversation(params: {
  channelId: string;
  guildId: string | null;
}): Promise<boolean> {
  const existing = await db
    .select({
      id: conversations.id,
      modelOverride: conversations.modelOverride,
    })
    .from(conversations)
    // same key the row was created under, so the delete and the re-insert
    // below can't land on different rows
    .where(conversationKey(params.channelId, params.guildId))
    .limit(1);

  if (!existing[0]) return false;

  await db.delete(conversations).where(eq(conversations.id, existing[0].id));

  if (existing[0].modelOverride) {
    await setConversationModelOverride({
      ...params,
      model: existing[0].modelOverride,
    });
  }

  return true;
}

/**
 * Enable heartbeat monitoring for a specific channel.
 */
export async function enableHeartbeatForChannel(
  guildId: string | null,
  channelId: string
): Promise<void> {
  await db
    .insert(heartbeatChannels)
    .values({
      guildId,
      channelId,
      enabled: true,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: heartbeatChannels.channelId,
      set: {
        enabled: true,
        updatedAt: new Date(),
      },
    });
}

/**
 * Disable heartbeat monitoring for a specific channel.
 */
export async function disableHeartbeatForChannel(
  channelId: string
): Promise<void> {
  await db
    .update(heartbeatChannels)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(heartbeatChannels.channelId, channelId));
}

/**
 * Get all channels with heartbeat enabled.
 */
export async function getHeartbeatChannels(): Promise<
  Array<{
    guildId: string | null;
    channelId: string;
  }>
> {
  const rows = await db
    .select()
    .from(heartbeatChannels)
    .where(eq(heartbeatChannels.enabled, true));

  return rows.map((row) => ({
    guildId: row.guildId,
    channelId: row.channelId,
  }));
}

/**
 * Check if heartbeat is enabled for a specific channel.
 */
export async function isHeartbeatEnabledForChannel(
  channelId: string
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(heartbeatChannels)
    .where(eq(heartbeatChannels.channelId, channelId))
    .limit(1);

  return row?.enabled ?? false;
}
