import type { ToolCallPart, ToolContent } from "@ai-sdk/provider-utils";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export const EMBEDDING_DIMENSIONS = 1536;

// conversations — one per discord channel/thread
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    channelId: text("channel_id").notNull(),
    guildId: text("guild_id"),
    model: text("model").notNull(),
    systemPrompt: text("system_prompt"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_conversations_channel").on(t.channelId),
    unique("idx_conversations_channel_guild").on(t.channelId, t.guildId).nullsNotDistinct(),
  ]
);

// messages — ordered history within a conversation
export const messages = pgTable(
  "messages",
  {
    id: serial("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant | tool
    content: text("content"),
    toolCalls: jsonb("tool_calls").$type<ToolCallPart[]>(), // assistant tool-call parts
    toolResults: jsonb("tool_results").$type<ToolContent>(), // tool result parts
    userId: text("user_id"), // Discord user ID (for user messages)
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_messages_conversation").on(t.conversationId),
    index("idx_messages_user").on(t.userId),
  ]
);

// user facts — extracted preferences and information about users
export const userFacts = pgTable(
  "user_facts",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    guildId: text("guild_id"), // facts can be guild-scoped or global
    fact: text("fact").notNull(),
    category: text("category"), // e.g. "preference", "personal", "technical", "context"
    confidence: integer("confidence").default(80), // 0-100, for pruning stale/low-quality facts
    supersededBy: integer("superseded_by"), // self-ref: if a newer fact replaces this one
    active: boolean("active").default(true).notNull(),
    sourceMessageId: integer("source_message_id").references(
      () => messages.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_user_facts_user").on(t.userId),
    index("idx_user_facts_user_guild").on(t.userId, t.guildId),
    index("idx_user_facts_active").on(t.userId, t.active),
  ]
);

// message embeddings — for RAG retrieval
export const messageEmbeddings = pgTable(
  "message_embeddings",
  {
    id: serial("id").primaryKey(),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    guildId: text("guild_id"),
    content: text("content").notNull(), // denormalized for display without joins
    embedding: vector("embedding", {
      dimensions: EMBEDDING_DIMENSIONS,
    }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_embeddings_conversation").on(t.conversationId),
    index("idx_embeddings_user").on(t.userId),
  ]
);

// topic knowledge — structured knowledge about subjects discussed
export const topicKnowledge = pgTable(
  "topic_knowledge",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    tags: text("tags").array().notNull().default([]),
    guildId: text("guild_id"),
    createdByUserId: text("created_by_user_id"),
    sourceConversationId: uuid("source_conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" }
    ),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    active: boolean("active").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_topic_knowledge_guild").on(t.guildId),
    index("idx_topic_knowledge_active").on(t.active),
  ]
);

// scheduled tasks — one-shot reminders and recurring cron jobs
export const scheduledTasks = pgTable(
  "scheduled_tasks",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id"),
    channelId: text("channel_id").notNull(),
    createdByUserId: text("created_by_user_id").notNull(),
    name: text("name").notNull(),
    instruction: text("instruction").notNull(),
    cronExpression: text("cron_expression"),
    timezone: text("timezone").default("UTC").notNull(),
    nextRunAt: timestamp("next_run_at").notNull(),
    lastRunAt: timestamp("last_run_at"),
    enabled: boolean("enabled").default(true).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_scheduled_tasks_next_run").on(t.nextRunAt),
    index("idx_scheduled_tasks_channel").on(t.channelId),
    index("idx_scheduled_tasks_enabled").on(t.enabled),
    index("idx_scheduled_tasks_due").on(t.enabled, t.nextRunAt),
  ]
);

export const heartbeatChannels = pgTable("heartbeat_channels", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id"),
  channelId: text("channel_id").notNull().unique(),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Types
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type HeartbeatChannel = typeof heartbeatChannels.$inferSelect;
export type DBMessage = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type UserFact = typeof userFacts.$inferSelect;
export type NewUserFact = typeof userFacts.$inferInsert;
export type TopicKnowledge = typeof topicKnowledge.$inferSelect;
export type ScheduledTask = typeof scheduledTasks.$inferSelect;
export type NewScheduledTask = typeof scheduledTasks.$inferInsert;
