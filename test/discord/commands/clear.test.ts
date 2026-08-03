import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";
import {
  installFakeClient,
  lastReplyText,
  loaderContext,
  makeInteraction,
  stubRegistry,
} from "./harness.js";

bootstrapTestEnv();
installFakeClient();

const { runMigrations } = await import("../../../src/db/migrate.js");
const { getOrCreateConversation } = await import("../../../src/db/queries.js");
const { env } = await import("../../../src/config/env.js");
const { ClearCommand } = await import("../../../src/discord/commands/clear.js");

const command = new ClearCommand(loaderContext("clear"), {});

beforeAll(async () => {
  await runMigrations();
});

test("registers one global command when GUILD_ID is unset", () => {
  env.GUILD_ID = undefined;
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(chatInput.length, 1);
  assert.equal(chatInput[0]?.builder.name, "clear");
  const json = chatInput[0]?.builder.toJSON();
  assert.ok(json?.integration_types && json.integration_types.length === 2);
});

test("adds a guild-scoped registration when GUILD_ID is set", () => {
  env.GUILD_ID = "guild-42";
  try {
    const { chatInput, registry } = stubRegistry();
    command.registerApplicationCommands(registry);

    assert.equal(chatInput.length, 2);
    assert.deepEqual(chatInput[0]?.options, { guildIds: ["guild-42"] });
  } finally {
    env.GUILD_ID = undefined;
  }
});

test("clears an existing conversation and reports it", async () => {
  await getOrCreateConversation({ channelId: "chan-clear", guildId: "g1" });

  const interaction = makeInteraction({
    guildId: "g1",
    channelId: "chan-clear",
  });
  await command.chatInputRun(interaction as never);

  assert.equal(interaction.deferReply.mock.calls.length, 1);
  assert.equal(lastReplyText(interaction), "Conversation cleared.");
});

test("says so when there is nothing to clear", async () => {
  const interaction = makeInteraction({
    guildId: null,
    channelId: "chan-never-used",
  });
  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    "No conversation to clear in this channel."
  );
});
