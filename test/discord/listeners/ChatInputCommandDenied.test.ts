import assert from "node:assert/strict";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";
import { captureLog, fakeInteraction, loaderContext } from "./fixtures.js";

bootstrapTestEnv();

const { ChatInputCommandDeniedListener } = await import(
  "../../../src/discord/listeners/ChatInputCommandDenied.js"
);
const { Events, UserError } = await import("@sapphire/framework");
const { MessageFlags } = await import("discord.js");
const { logger } = await import("../../../src/config/logger.js");

const listener = new ChatInputCommandDeniedListener(
  loaderContext("chatInputCommandDenied"),
  {}
);
const error = new UserError({
  identifier: "preconditionFailed",
  message: "not on the allowlist",
});
const command = { name: "ask" };

function run(interaction: ReturnType<typeof fakeInteraction>) {
  return listener.run(error, { interaction, command } as never);
}

test("wires itself to the ChatInputCommandDenied event", () => {
  assert.equal(listener.event, Events.ChatInputCommandDenied);
});

test("replies ephemerally when the interaction is still unanswered", async () => {
  const interaction = fakeInteraction();
  const debugCalls = await captureLog(logger, "debug", () => run(interaction));

  assert.equal(interaction.reply.mock.calls.length, 1);
  assert.deepEqual(interaction.reply.mock.calls[0]?.[0], {
    content: "Access denied.",
    flags: MessageFlags.Ephemeral,
  });
  assert.equal(interaction.editReply.mock.calls.length, 0);
  assert.match(String(debugCalls[0]?.[0]), /denied for \/ask/);
  assert.equal(
    (debugCalls[0]?.[1] as { reason?: string })?.reason,
    "not on the allowlist"
  );
});

test("edits the reply when the interaction was deferred", async () => {
  const interaction = fakeInteraction({ deferred: true });
  await captureLog(logger, "debug", () => run(interaction));

  assert.equal(interaction.editReply.mock.calls.length, 1);
  assert.equal(interaction.editReply.mock.calls[0]?.[0], "Access denied.");
  assert.equal(interaction.reply.mock.calls.length, 0);
});

test("edits the reply when the interaction was already replied to", async () => {
  const interaction = fakeInteraction({ replied: true });
  await captureLog(logger, "debug", () => run(interaction));

  assert.equal(interaction.editReply.mock.calls.length, 1);
  assert.equal(interaction.reply.mock.calls.length, 0);
});

test("swallows reply failures instead of throwing", async () => {
  const interaction = fakeInteraction();
  interaction.reply.mockRejectedValue(new Error("Unknown interaction"));
  await captureLog(logger, "debug", () => run(interaction));

  const deferred = fakeInteraction({ deferred: true });
  deferred.editReply.mockRejectedValue(new Error("Unknown interaction"));
  await captureLog(logger, "debug", () => run(deferred));
});
