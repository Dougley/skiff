import assert from "node:assert/strict";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";
import { captureLog, fakeInteraction, loaderContext } from "./fixtures.js";

bootstrapTestEnv();

const { ContextMenuCommandErrorListener } = await import(
  "../../../src/discord/listeners/ContextMenuCommandError.js"
);
const { Events } = await import("@sapphire/framework");
const { MessageFlags } = await import("discord.js");
const { logger } = await import("../../../src/config/logger.js");

const listener = new ContextMenuCommandErrorListener(
  loaderContext("contextMenuCommandError"),
  {}
);
const error = new Error("tool call blew up");
const command = { name: "Ask Skiff" };

function run(interaction: ReturnType<typeof fakeInteraction>) {
  return listener.run(error, { interaction, command } as never);
}

test("wires itself to the ContextMenuCommandError event", () => {
  assert.equal(listener.event, Events.ContextMenuCommandError);
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

  assert.match(String(errorCalls[0]?.[0]), /error in Ask Skiff/);
  const fields = errorCalls[0]?.[1] as Record<string, unknown>;
  assert.equal(fields.err, error);
  assert.equal(fields.userId, "user-1");
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
