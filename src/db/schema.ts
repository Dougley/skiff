import type { ToolCallPart, ToolContent } from "@ai-sdk/provider-utils";
import { sql } from "drizzle-orm";
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
  uniqueIndex,
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
    // rolling compaction: summary of messages up to (and including)
    // summary_up_to_message_id, which are excluded from the prompt history
    summary: text("summary"),
    summaryUpToMessageId: integer("summary_up_to_message_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_conversations_channel").on(t.channelId),
    unique("idx_conversations_channel_guild")
      .on(t.channelId, t.guildId)
      .nullsNotDistinct(),
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
    lastInputTokens: integer("last_input_tokens"), // provider-reported input tokens for the turn that produced this message
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_messages_conversation").on(t.conversationId),
    index("idx_messages_user").on(t.userId),
  ]
);

// user facts — extracted preferences and information about users.
// three scopes: global (guild_id and channel_id both null — durable quirks,
// visible everywhere), guild (guild_id set), and channel (channel_id set —
// DM-only; guild conversations never create or see channel facts)
export const userFacts = pgTable(
  "user_facts",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    guildId: text("guild_id"),
    channelId: text("channel_id"),
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
    index("idx_user_facts_user_channel").on(t.userId, t.channelId),
    index("idx_user_facts_active").on(t.userId, t.active),
  ]
);

// message embeddings — for RAG retrieval. embeddings are long-term memory:
// they survive /clear (set null instead of cascade) and are scoped by
// channel_id so a fresh conversation in the same channel can still recall them
export const messageEmbeddings = pgTable(
  "message_embeddings",
  {
    id: serial("id").primaryKey(),
    messageId: integer("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    channelId: text("channel_id"),
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
    index("idx_embeddings_channel").on(t.channelId),
    index("idx_embeddings_user").on(t.userId),
  ]
);

// topic knowledge — structured knowledge about subjects discussed.
// scoped like user facts: guild (guild_id set), channel (channel_id set —
// DM conversations), or legacy/global (both null, visible in DMs only)
export const topicKnowledge = pgTable(
  "topic_knowledge",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    tags: text("tags").array().notNull().default([]),
    guildId: text("guild_id"),
    channelId: text("channel_id"),
    createdByUserId: text("created_by_user_id"),
    sourceConversationId: uuid("source_conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" }
    ),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    active: boolean("active").default(true).notNull(),
    // Self-ref: set when a dedup pass merges this topic into another
    supersededBy: integer("superseded_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_topic_knowledge_guild").on(t.guildId),
    index("idx_topic_knowledge_channel").on(t.channelId),
    index("idx_topic_knowledge_active").on(t.active),
  ]
);

// logbook storylines — durable, evolving records of work in progress.
// Unlike topic knowledge (a summary of what was discussed), a storyline
// captures what a scope is trying to accomplish and where it currently stands.
export const storylines = pgTable(
  "storylines",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    currentState: text("current_state").notNull(),
    status: text("status").default("open").notNull(), // open|paused|completed|abandoned
    guildId: text("guild_id"),
    channelId: text("channel_id"),
    createdByUserId: text("created_by_user_id"),
    ownerUserIds: text("owner_user_ids").array().notNull().default([]),
    tags: text("tags").array().notNull().default([]),
    sourceMessageId: integer("source_message_id").references(
      () => messages.id,
      { onDelete: "set null" }
    ),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    lastActivityAt: timestamp("last_activity_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_storylines_guild").on(t.guildId),
    index("idx_storylines_channel").on(t.channelId),
    index("idx_storylines_status").on(t.status),
    index("idx_storylines_activity").on(t.lastActivityAt),
  ]
);

// logbook events — append-only evidence of how a storyline changed.
// Open questions, commitments, and risks remain active until explicitly
// resolved; decisions and notes form the permanent decision trail.
export const storylineEvents = pgTable(
  "storyline_events",
  {
    id: serial("id").primaryKey(),
    storylineId: integer("storyline_id")
      .notNull()
      .references(() => storylines.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // note|decision|open_question|commitment|risk|milestone
    summary: text("summary").notNull(),
    details: text("details"),
    status: text("status").default("active").notNull(), // active|resolved|dismissed
    actorUserId: text("actor_user_id"),
    ownerUserId: text("owner_user_id"),
    dueAt: timestamp("due_at"),
    sourceMessageId: integer("source_message_id").references(
      () => messages.id,
      { onDelete: "set null" }
    ),
    resolvedAt: timestamp("resolved_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_storyline_events_storyline").on(t.storylineId),
    index("idx_storyline_events_status").on(t.status),
    index("idx_storyline_events_due").on(t.dueAt),
  ]
);

// The Wake — typed causal links between Logbook events. Links may connect
// events in different storylines, which lets a decision in one endeavor
// explain a later commitment or outcome elsewhere.
export const storylineEventLinks = pgTable(
  "storyline_event_links",
  {
    id: serial("id").primaryKey(),
    fromEventId: integer("from_event_id")
      .notNull()
      .references(() => storylineEvents.id, { onDelete: "cascade" }),
    toEventId: integer("to_event_id")
      .notNull()
      .references(() => storylineEvents.id, { onDelete: "cascade" }),
    relation: text("relation").notNull(), // supports|depends_on|contradicts|supersedes|caused_by
    rationale: text("rationale"),
    createdByUserId: text("created_by_user_id"),
    sourceMessageId: integer("source_message_id").references(
      () => messages.id,
      { onDelete: "set null" }
    ),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("idx_storyline_event_links_unique").on(
      t.fromEventId,
      t.toEventId,
      t.relation
    ),
    index("idx_storyline_event_links_from").on(t.fromEventId),
    index("idx_storyline_event_links_to").on(t.toEventId),
  ]
);

// Additional evidence for an event. storyline_events.source_message_id remains
// the primary source; this table allows later messages to corroborate it.
export const storylineEventSources = pgTable(
  "storyline_event_sources",
  {
    id: serial("id").primaryKey(),
    eventId: integer("event_id")
      .notNull()
      .references(() => storylineEvents.id, { onDelete: "cascade" }),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    note: text("note"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("idx_storyline_event_sources_unique").on(t.eventId, t.messageId),
    index("idx_storyline_event_sources_event").on(t.eventId),
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

// sapphire idHints — Discord command ids assigned at registration, replayed
// as idHints on the next startup so renamed commands don't create duplicates
export const commandIdHints = pgTable("command_id_hints", {
  commandName: text("command_name").primaryKey(),
  ids: text("ids").array().notNull().default([]),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const heartbeatChannels = pgTable("heartbeat_channels", {
  id: serial("id").primaryKey(),
  guildId: text("guild_id"),
  channelId: text("channel_id").notNull().unique(),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// sleep cycle — per-scope settings gating the background "dream" pass.
// a row is keyed by exactly one of guild_id (guild scope) or channel_id
// (DM scope); the partial unique indexes enforce one row per scope
export const sleepCycleSettings = pgTable(
  "sleep_cycle_settings",
  {
    guildId: text("guild_id"),
    channelId: text("channel_id"),
    enabled: boolean("enabled").default(false).notNull(),
    dryRun: boolean("dry_run").default(true).notNull(),
    autoAuthorSkills: boolean("auto_author_skills").default(false).notNull(),
    // channel to post a digest to after each scheduled dream pass (null = off)
    reportChannelId: text("report_channel_id"),
    lowActivityMinutes: integer("low_activity_minutes").default(60).notNull(),
    minInactiveMessages: integer("min_inactive_messages").default(3).notNull(),
    maxRunsPerDay: integer("max_runs_per_day").default(2).notNull(),
    lastRunAt: timestamp("last_run_at"),
    nextEligibleAt: timestamp("next_eligible_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("idx_sleep_settings_guild")
      .on(t.guildId)
      .where(sql`guild_id is not null`),
    uniqueIndex("idx_sleep_settings_channel")
      .on(t.channelId)
      .where(sql`channel_id is not null`),
  ]
);

// sleep cycle — audit log, one row per dream pass
export const sleepCycleRuns = pgTable(
  "sleep_cycle_runs",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id"),
    channelId: text("channel_id"), // set for DM-scoped runs
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
    status: text("status").default("running").notNull(), // running|succeeded|failed|skipped
    phaseStats: jsonb("phase_stats").$type<Record<string, unknown>>(),
    tokenCost: integer("token_cost"),
    triggerReason: text("trigger_reason"), // "scheduled" | "manual" | "test"
    dryRun: boolean("dry_run").default(false).notNull(),
    error: text("error"),
  },
  (t) => [
    index("idx_sleep_runs_guild").on(t.guildId),
    index("idx_sleep_runs_started").on(t.startedAt),
  ]
);

// sleep cycle — fine-grained change log for rollback/review
export const sleepCycleChanges = pgTable(
  "sleep_cycle_changes",
  {
    id: serial("id").primaryKey(),
    runId: integer("run_id")
      .notNull()
      .references(() => sleepCycleRuns.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // persona_addendum|topic_merge|fact_resolve|wake_link|skill_author
    targetTable: text("target_table"),
    targetId: text("target_id"),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    reverted: boolean("reverted").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_sleep_changes_run").on(t.runId),
    index("idx_sleep_changes_kind").on(t.kind),
  ]
);

// sleep cycle — durable persona addenda that survive restart
export const personaAddenda = pgTable(
  "persona_addenda",
  {
    id: serial("id").primaryKey(),
    guildId: text("guild_id"), // guild scope; null with channelId null = global
    channelId: text("channel_id"), // DM scope
    target: text("target"), // null = free-form; else a dotted persona path
    text: text("text").notNull(),
    reason: text("reason"),
    sourceRunId: integer("source_run_id").references(() => sleepCycleRuns.id, {
      onDelete: "set null",
    }),
    confidence: integer("confidence").default(80).notNull(),
    active: boolean("active").default(true).notNull(),
    supersededBy: integer("superseded_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    retiredAt: timestamp("retired_at"),
  },
  (t) => [
    index("idx_persona_addenda_guild").on(t.guildId),
    index("idx_persona_addenda_channel").on(t.channelId),
    index("idx_persona_addenda_active").on(t.active),
  ]
);

// Types
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type HeartbeatChannel = typeof heartbeatChannels.$inferSelect;
export type DBMessage = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type UserFact = typeof userFacts.$inferSelect;
export type NewUserFact = typeof userFacts.$inferInsert;
export type TopicKnowledge = typeof topicKnowledge.$inferSelect;
export type Storyline = typeof storylines.$inferSelect;
export type NewStoryline = typeof storylines.$inferInsert;
export type StorylineEvent = typeof storylineEvents.$inferSelect;
export type NewStorylineEvent = typeof storylineEvents.$inferInsert;
export type StorylineEventLink = typeof storylineEventLinks.$inferSelect;
export type StorylineEventSource = typeof storylineEventSources.$inferSelect;
export type ScheduledTask = typeof scheduledTasks.$inferSelect;
export type NewScheduledTask = typeof scheduledTasks.$inferInsert;
export type SleepCycleSettings = typeof sleepCycleSettings.$inferSelect;
export type NewSleepCycleSettings = typeof sleepCycleSettings.$inferInsert;
export type SleepCycleRun = typeof sleepCycleRuns.$inferSelect;
export type NewSleepCycleRun = typeof sleepCycleRuns.$inferInsert;
export type SleepCycleChange = typeof sleepCycleChanges.$inferSelect;
export type NewSleepCycleChange = typeof sleepCycleChanges.$inferInsert;
export type PersonaAddendum = typeof personaAddenda.$inferSelect;
export type NewPersonaAddendum = typeof personaAddenda.$inferInsert;
