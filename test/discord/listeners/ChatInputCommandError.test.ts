import assert from "node:assert/strict";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";
import { captureLog, fakeInteraction, loaderContext } from "./fixtures.js";

bootstrapTestEnv();

const { ChatInputCommandErrorListener } = await import(
  "../../../src/discord/listeners/ChatInputCommandError.js"
);
const { Events } = await import("@sapphire/framework");
const { MessageFlags } = await import("discord.js");
const { logger } = await import("../../../src/config/logger.js");

const listener = new ChatInputCommandErrorListener(
  loaderContext("chatInputCommandError"),
  {}
);
const error = new Error("upstream exploded");
const command = { name: "ask" };

function run(interaction: ReturnType<typeof fakeInteraction>) {
  return listener.run(error, { interaction, command } as never);
}

test("wires itself to the ChatInputCommandError event", () => {
  assert.equal(listener.event, Events.ChatInputCommandError);
});

test("replies ephemerally and logs the error with interaction context", async () => {
  const interaction = fakeInteraction();
  const errorCalls = await captureLog(logger, "error", () => run(interaction));

  assert.equal(interaction.reply.mock.calls.length, 1);
  assert.deepEqual(interaction.reply.mock.calls[0]?.[0], {
    content: "Something went wrong — try again in a moment.",
    flags: MessageFlags.Ephemeral,
  });
  assert.equal(interaction.editReply.mock.calls.length, 0);

  assert.match(String(errorCalls[0]?.[0]), /error in \/ask/);
  const fields = errorCalls[0]?.[1] as Record<string, unknown>;
  assert.equal(fields.err, error);
  assert.equal(fields.userId, "user-1");
  assert.equal(fields.channelId, "channel-1");
  assert.equal(fields.guildId, "guild-1");
});

test("edits the reply when the interaction was deferred", async () => {
  const interaction = fakeInteraction({ deferred: true });
  await captureLog(logger, "error", () => run(interaction));

  assert.equal(interaction.editReply.mock.calls.length, 1);
  assert.equal(
    interaction.editReply.mock.calls[0]?.[0],
    "Something went wrong — try again in a moment."
  );
  assert.equal(interaction.reply.mock.calls.length, 0);
});

test("edits the reply when the interaction was already replied to", async () => {
  const interaction = fakeInteraction({ replied: true });
  await captureLog(logger, "error", () => run(interaction));

  assert.equal(interaction.editReply.mock.calls.length, 1);
  assert.equal(interaction.reply.mock.calls.length, 0);
});

test("swallows reply failures instead of throwing", async () => {
  const interaction = fakeInteraction();
  interaction.reply.mockRejectedValue(new Error("Unknown interaction"));
  await captureLog(logger, "error", () => run(interaction));

  const deferred = fakeInteraction({ deferred: true });
  deferred.editReply.mockRejectedValue(new Error("Unknown interaction"));
  await captureLog(logger, "error", () => run(deferred));
});
