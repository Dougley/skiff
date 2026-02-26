import type { ToolCallPart, ToolContent } from "@ai-sdk/provider-utils";
import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { env } from "../env/index.js";
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
  const existing = await db
    .select()
    .from(conversations)
    .where(
      input.guildId
        ? and(
            eq(conversations.channelId, input.channelId),
            eq(conversations.guildId, input.guildId)
          )
        : eq(conversations.channelId, input.channelId)
    )
    .orderBy(desc(conversations.createdAt))
    .limit(1);

  if (existing[0]) {
    await db
      .update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, existing[0].id));
    return existing[0];
  }

  const created = await db
    .insert(conversations)
    .values({
      channelId: input.channelId,
      guildId: input.guildId ?? null,
      model: input.model ?? env.LLM_DEFAULT_MODEL,
      systemPrompt: input.systemPrompt ?? null,
    })
    .returning();

  if (!created[0]) throw new Error("Failed to create conversation");
  return created[0];
}

export type MessageInsert = {
  conversationId: string;
  role: string;
  content: string | null;
  userId?: string | null;
  toolCalls?: ToolCallPart[] | null;
  toolResults?: ToolContent | null;
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
// includes user/assistant text, assistant tool calls, and tool results
export async function getRecentMessages(
  conversationId: string,
  limit?: number
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
        or(
          isNotNull(messages.content),
          isNotNull(messages.toolCalls),
          isNotNull(messages.toolResults)
        )
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit ?? env.RAG_RECENT_LIMIT);

  return rows.reverse();
}

/**
 * Delete a conversation and all its messages/embeddings (via cascade).
 * Returns true if a conversation was found and deleted.
 */
export async function deleteConversation(params: {
  channelId: string;
  guildId: string | null;
}): Promise<boolean> {
  const existing = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      params.guildId
        ? and(
            eq(conversations.channelId, params.channelId),
            eq(conversations.guildId, params.guildId)
          )
        : eq(conversations.channelId, params.channelId)
    )
    .limit(1);

  if (!existing[0]) return false;

  await db.delete(conversations).where(eq(conversations.id, existing[0].id));

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
