import assert from "node:assert/strict";
import test from "node:test";

process.env.DISCORD_BOT_TOKEN = `${Buffer.from("123456789012345678").toString("base64")}.test.signature`;
process.env.OPENAI_API_KEY = "test";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.DATABASE_URL = "memory://";
process.env.LLM_DEFAULT_MODEL = "gpt-4o-mini";

const { env } = await import("../src/config/env.js");
const { resolveModel } = await import("../src/ai/llm/models.js");
const { runMigrations } = await import("../src/db/migrate.js");
const {
  deleteConversation,
  getConversation,
  getOrCreateConversation,
  insertMessage,
  setConversationModelOverride,
} = await import("../src/db/queries.js");

await runMigrations();

test("/model set on an unused channel records the override, not a new creation model", async () => {
  const scope = { channelId: "chan-set", guildId: "guild-1" };
  await setConversationModelOverride({ ...scope, model: "gpt-4o" });

  const conversation = await getConversation(scope);
  assert.ok(conversation);
  assert.equal(conversation.modelOverride, "gpt-4o");
  // `model` is historical — it must keep saying what the conversation was
  // created under, not follow the runtime switch
  assert.equal(conversation.model, env.LLM_DEFAULT_MODEL);
  assert.equal(resolveModel(conversation.modelOverride), "gpt-4o");
});

test("/model reset clears the override and falls back to the default", async () => {
  const scope = { channelId: "chan-reset", guildId: "guild-1" };
  await setConversationModelOverride({ ...scope, model: "gpt-4o" });
  await setConversationModelOverride({ ...scope, model: null });

  const conversation = await getConversation(scope);
  assert.ok(conversation);
  assert.equal(conversation.modelOverride, null);
  assert.equal(resolveModel(conversation.modelOverride), env.LLM_DEFAULT_MODEL);
});

test("switching a channel already in use leaves its history alone", async () => {
  const scope = { channelId: "chan-live", guildId: "guild-1" };
  const conversation = await getOrCreateConversation(scope);
  await insertMessage({
    conversationId: conversation.id,
    role: "user",
    content: "hi",
  });

  await setConversationModelOverride({ ...scope, model: "gpt-4o" });

  const after = await getConversation(scope);
  assert.equal(after?.id, conversation.id);
  assert.equal(after?.modelOverride, "gpt-4o");
});

test("/clear wipes history but keeps the channel's model selection", async () => {
  const scope = { channelId: "chan-clear", guildId: "guild-1" };
  await setConversationModelOverride({ ...scope, model: "gpt-4o" });
  const before = await getConversation(scope);
  await insertMessage({
    conversationId: before?.id as string,
    role: "user",
    content: "hi",
  });

  assert.equal(await deleteConversation(scope), true);

  const after = await getConversation(scope);
  assert.ok(after);
  assert.notEqual(after.id, before?.id);
  assert.equal(after.modelOverride, "gpt-4o");
});

test("/clear in a DM finds the row and preserves the selection", async () => {
  const scope = { channelId: "chan-dm", guildId: null };
  await setConversationModelOverride({ ...scope, model: "gpt-4o" });

  assert.equal(await deleteConversation(scope), true);
  assert.equal((await getConversation(scope))?.modelOverride, "gpt-4o");
});

test("/clear on an untouched channel reports nothing to clear", async () => {
  assert.equal(
    await deleteConversation({ channelId: "chan-none", guildId: "guild-1" }),
    false
  );
});
