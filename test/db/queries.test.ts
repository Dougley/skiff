import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { bootstrapTestEnv } from "../helpers/setup.js";

bootstrapTestEnv();

let queries: typeof import("../../src/db/queries.js");
let schema: typeof import("../../src/db/schema.js");
let db: typeof import("../../src/db/index.js").db;

beforeAll(async () => {
  const [{ runMigrations }, q, dbIndex] = await Promise.all([
    import("../../src/db/migrate.js"),
    import("../../src/db/queries.js"),
    import("../../src/db/index.js"),
  ]);
  await runMigrations();
  queries = q;
  schema = dbIndex;
  db = dbIndex.db;
});

test("getOrCreateConversation creates a row with env defaults, then upserts", async () => {
  const created = await queries.getOrCreateConversation({
    channelId: "chan-create",
    guildId: "guild-create",
  });

  assert.equal(created.channelId, "chan-create");
  assert.equal(created.guildId, "guild-create");
  // no explicit model: falls back to LLM_DEFAULT_MODEL
  assert.equal(created.model, "gpt-4o-mini");
  assert.equal(created.systemPrompt, null);
  assert.equal(created.modelOverride, null);

  const again = await queries.getOrCreateConversation({
    channelId: "chan-create",
    guildId: "guild-create",
    // conflicting values are ignored — only updatedAt moves
    model: "some-other-model",
    systemPrompt: "ignored on conflict",
  });

  assert.equal(again.id, created.id);
  assert.equal(again.model, "gpt-4o-mini");
  assert.equal(again.systemPrompt, null);
  assert.ok(again.updatedAt.getTime() >= created.updatedAt.getTime());
});

test("getOrCreateConversation honours an explicit model and system prompt", async () => {
  const created = await queries.getOrCreateConversation({
    channelId: "chan-explicit",
    guildId: null,
    model: "gpt-5",
    systemPrompt: "be terse",
  });

  assert.equal(created.model, "gpt-5");
  assert.equal(created.systemPrompt, "be terse");
  assert.equal(created.guildId, null);
});

test("a DM conversation and a guild conversation can share a channel id", async () => {
  const dm = await queries.getOrCreateConversation({
    channelId: "shared-chan",
    guildId: null,
  });
  const guild = await queries.getOrCreateConversation({
    channelId: "shared-chan",
    guildId: "guild-shared",
  });

  assert.notEqual(dm.id, guild.id);

  // conversationKey distinguishes them: null guild uses IS NULL, not equality
  const foundDm = await queries.getConversation({
    channelId: "shared-chan",
    guildId: null,
  });
  const foundGuild = await queries.getConversation({
    channelId: "shared-chan",
    guildId: "guild-shared",
  });

  assert.equal(foundDm?.id, dm.id);
  assert.equal(foundGuild?.id, guild.id);
});

test("getConversation returns null for a channel with no history", async () => {
  assert.equal(
    await queries.getConversation({
      channelId: "never-used",
      guildId: null,
    }),
    null
  );
});

test("setConversationModelOverride creates the row when the channel is new", async () => {
  await queries.setConversationModelOverride({
    channelId: "chan-override-new",
    guildId: "guild-override",
    model: "claude-sonnet",
  });

  const row = await queries.getConversation({
    channelId: "chan-override-new",
    guildId: "guild-override",
  });
  assert.equal(row?.modelOverride, "claude-sonnet");
  // the historical `model` column still records the default
  assert.equal(row?.model, "gpt-4o-mini");
});

test("setConversationModelOverride updates and clears an existing row", async () => {
  const created = await queries.getOrCreateConversation({
    channelId: "chan-override-existing",
    guildId: null,
  });

  await queries.setConversationModelOverride({
    channelId: "chan-override-existing",
    guildId: null,
    model: "claude-opus",
  });
  const updated = await queries.getConversation({
    channelId: "chan-override-existing",
    guildId: null,
  });
  assert.equal(updated?.id, created.id);
  assert.equal(updated?.modelOverride, "claude-opus");

  await queries.setConversationModelOverride({
    channelId: "chan-override-existing",
    guildId: null,
    model: null,
  });
  const cleared = await queries.getConversation({
    channelId: "chan-override-existing",
    guildId: null,
  });
  assert.equal(cleared?.id, created.id);
  assert.equal(cleared?.modelOverride, null);
});

test("insertMessage defaults optional columns and bumps the conversation", async () => {
  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-insert",
    guildId: null,
  });
  const before = conversation.updatedAt;

  const message = await queries.insertMessage({
    conversationId: conversation.id,
    role: "user",
    content: "hello",
  });

  assert.equal(message.role, "user");
  assert.equal(message.content, "hello");
  assert.equal(message.userId, null);
  assert.equal(message.toolCalls, null);
  assert.equal(message.toolResults, null);
  assert.equal(message.lastInputTokens, null);

  const after = await queries.getConversation({
    channelId: "chan-insert",
    guildId: null,
  });
  assert.ok(after);
  assert.ok(after.updatedAt.getTime() >= before.getTime());
});

test("insertMessage round-trips tool calls, results and token counts", async () => {
  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-tools",
    guildId: null,
  });

  const toolCalls = [
    {
      type: "tool-call" as const,
      toolCallId: "call-1",
      toolName: "web_search",
      input: { query: "skiff" },
    },
  ];
  const toolResults = [
    {
      type: "tool-result" as const,
      toolCallId: "call-1",
      toolName: "web_search",
      output: { type: "text" as const, value: "a result" },
    },
  ];

  const assistant = await queries.insertMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: null,
    userId: "user-1",
    toolCalls,
    toolResults,
    lastInputTokens: 4321,
  });

  assert.equal(assistant.userId, "user-1");
  assert.equal(assistant.lastInputTokens, 4321);
  assert.deepEqual(assistant.toolCalls, toolCalls);
  assert.deepEqual(assistant.toolResults, toolResults);
});

test("getRecentMessages returns oldest-first and skips fully empty rows", async () => {
  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-recent",
    guildId: null,
  });

  for (const content of ["one", "two", "three"]) {
    await queries.insertMessage({
      conversationId: conversation.id,
      role: "user",
      content,
    });
  }
  // a row with no content, no tool calls and no tool results is filtered out
  await queries.insertMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: null,
  });

  const rows = await queries.getRecentMessages(conversation.id);
  assert.deepEqual(
    rows.map((r) => r.content),
    ["one", "two", "three"]
  );
});

test("getRecentMessages applies the explicit limit and the env default", async () => {
  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-limit",
    guildId: null,
  });

  // one more than RAG_RECENT_LIMIT's default of 12
  const all = Array.from({ length: 13 }, (_, i) => `m${i}`);
  for (const content of all) {
    await queries.insertMessage({
      conversationId: conversation.id,
      role: "user",
      content,
    });
  }

  assert.deepEqual(
    (await queries.getRecentMessages(conversation.id, 2)).map((r) => r.content),
    ["m11", "m12"]
  );
  // no limit argument falls back to RAG_RECENT_LIMIT, keeping the newest 12
  assert.deepEqual(
    (await queries.getRecentMessages(conversation.id)).map((r) => r.content),
    all.slice(1)
  );
});

test("getRecentMessages honours afterMessageId and beforeMessageId", async () => {
  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-window",
    guildId: null,
  });

  const inserted = [];
  for (const content of ["m1", "m2", "m3", "m4"]) {
    inserted.push(
      await queries.insertMessage({
        conversationId: conversation.id,
        role: "user",
        content,
      })
    );
  }
  const [first, , third] = inserted;
  assert.ok(first && third);

  assert.deepEqual(
    (await queries.getRecentMessages(conversation.id, 10, first.id)).map(
      (r) => r.content
    ),
    ["m2", "m3", "m4"]
  );
  assert.deepEqual(
    (await queries.getRecentMessages(conversation.id, 10, null, third.id)).map(
      (r) => r.content
    ),
    ["m1", "m2"]
  );
  assert.deepEqual(
    (
      await queries.getRecentMessages(conversation.id, 10, first.id, third.id)
    ).map((r) => r.content),
    ["m2"]
  );
});

test("getRecentMessages drops tool results orphaned by the window", async () => {
  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-orphan",
    guildId: null,
  });

  await queries.insertMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: null,
    toolCalls: [
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "web_search",
        input: {},
      },
    ],
  });
  await queries.insertMessage({
    conversationId: conversation.id,
    role: "tool",
    content: null,
    toolResults: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "web_search",
        output: { type: "text", value: "result" },
      },
    ],
  });
  await queries.insertMessage({
    conversationId: conversation.id,
    role: "tool",
    content: null,
    toolResults: [
      {
        type: "tool-result",
        toolCallId: "c2",
        toolName: "web_search",
        output: { type: "text", value: "second" },
      },
    ],
  });
  await queries.insertMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: "done",
  });

  // a window of 3 would start on the two tool rows — both are dropped
  const rows = await queries.getRecentMessages(conversation.id, 3);
  assert.deepEqual(
    rows.map((r) => r.role),
    ["assistant"]
  );
  assert.equal(rows[0]?.content, "done");
});

test("getLastAssistantInputTokens returns null until a turn reports tokens", async () => {
  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-tokens",
    guildId: null,
  });

  await queries.insertMessage({
    conversationId: conversation.id,
    role: "user",
    content: "hi",
  });
  assert.equal(
    await queries.getLastAssistantInputTokens(conversation.id),
    null
  );

  await queries.insertMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: "hello",
    lastInputTokens: 120,
  });
  assert.equal(await queries.getLastAssistantInputTokens(conversation.id), 120);
});

test("deleteConversation reports false for an unknown channel", async () => {
  assert.equal(
    await queries.deleteConversation({
      channelId: "chan-absent",
      guildId: null,
    }),
    false
  );
});

test("deleteConversation removes the conversation and cascades its messages", async () => {
  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-delete",
    guildId: "guild-delete",
  });
  await queries.insertMessage({
    conversationId: conversation.id,
    role: "user",
    content: "goodbye",
  });

  assert.equal(
    await queries.deleteConversation({
      channelId: "chan-delete",
      guildId: "guild-delete",
    }),
    true
  );

  assert.equal(
    await queries.getConversation({
      channelId: "chan-delete",
      guildId: "guild-delete",
    }),
    null
  );
  const { eq } = await import("drizzle-orm");
  const orphans = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversation.id));
  assert.deepEqual(orphans, []);
});

test("deleteConversation carries a /model override onto the fresh row", async () => {
  await queries.setConversationModelOverride({
    channelId: "chan-delete-override",
    guildId: null,
    model: "claude-haiku",
  });
  const before = await queries.getConversation({
    channelId: "chan-delete-override",
    guildId: null,
  });

  assert.equal(
    await queries.deleteConversation({
      channelId: "chan-delete-override",
      guildId: null,
    }),
    true
  );

  const after = await queries.getConversation({
    channelId: "chan-delete-override",
    guildId: null,
  });
  assert.ok(after);
  // history is gone (new row) but the model selection survived
  assert.notEqual(after.id, before?.id);
  assert.equal(after.modelOverride, "claude-haiku");
});

test("heartbeat channels can be enabled, listed, re-enabled and disabled", async () => {
  assert.equal(
    await queries.isHeartbeatEnabledForChannel("hb-chan-a"),
    false,
    "unknown channels are not enabled"
  );

  await queries.enableHeartbeatForChannel("hb-guild", "hb-chan-a");
  await queries.enableHeartbeatForChannel(null, "hb-chan-b");

  assert.equal(await queries.isHeartbeatEnabledForChannel("hb-chan-a"), true);

  const enabled = await queries.getHeartbeatChannels();
  assert.deepEqual(
    enabled.map((row) => [row.guildId, row.channelId]).sort(),
    [
      [null, "hb-chan-b"],
      ["hb-guild", "hb-chan-a"],
    ].sort()
  );

  await queries.disableHeartbeatForChannel("hb-chan-a");
  assert.equal(await queries.isHeartbeatEnabledForChannel("hb-chan-a"), false);
  assert.deepEqual(
    (await queries.getHeartbeatChannels()).map((row) => row.channelId),
    ["hb-chan-b"]
  );

  // re-enabling takes the onConflictDoUpdate path on the unique channel index
  await queries.enableHeartbeatForChannel("hb-guild", "hb-chan-a");
  assert.equal(await queries.isHeartbeatEnabledForChannel("hb-chan-a"), true);
  assert.equal((await queries.getHeartbeatChannels()).length, 2);
});
