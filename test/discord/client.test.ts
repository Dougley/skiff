import assert from "node:assert/strict";
import { afterAll, test, vi } from "vitest";
import { bootstrapTestEnv } from "../helpers/setup.js";

bootstrapTestEnv();

const { ApplicationCommandRegistry, SapphireClient } = await import(
  "@sapphire/framework"
);
const { GatewayIntentBits, Partials } = await import("discord.js");

// importing the client patches the registry prototype with id-hint injection
const realRegisterChatInput =
  ApplicationCommandRegistry.prototype.registerChatInputCommand;
const realRegisterContextMenu =
  ApplicationCommandRegistry.prototype.registerContextMenuCommand;
afterAll(() => {
  ApplicationCommandRegistry.prototype.registerChatInputCommand =
    realRegisterChatInput;
  ApplicationCommandRegistry.prototype.registerContextMenuCommand =
    realRegisterContextMenu;
});

const { client, startClient } = await import("../../src/discord/client.js");
const { env } = await import("../../src/config/env.js");
const { logger } = await import("../../src/config/logger.js");

test("builds a SapphireClient with the intents the bot needs", () => {
  assert.ok(client instanceof SapphireClient);
  for (const intent of [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ]) {
    assert.equal(client.options.intents.has(intent), true);
  }
  // DM channels arrive uncached, so the partial is required to see them
  assert.deepEqual(client.options.partials, [Partials.Channel]);
});

test("loads pieces from the sources outside production", () => {
  assert.match(String(client.options.baseUserDirectory), /\/src\/discord$/);
});

test("loads pieces from the build output in production", async () => {
  const realNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  vi.resetModules();
  try {
    const { client: prodClient } = await import("../../src/discord/client.js");
    assert.match(
      String(prodClient.options.baseUserDirectory),
      /\/dist\/discord$/
    );
  } finally {
    process.env.NODE_ENV = realNodeEnv;
    vi.resetModules();
  }
});

test("logs in with the configured bot token", async () => {
  const login = vi.fn(async () => "token");
  const realLogin = client.login;
  client.login = login as typeof client.login;
  try {
    await startClient();
  } finally {
    client.login = realLogin;
  }

  assert.deepEqual(login.mock.calls, [[env.DISCORD_BOT_TOKEN]]);
});

test("announces the logged-in account once the client is ready", () => {
  const messages: unknown[] = [];
  const realInfo = logger.info;
  logger.info = ((message: unknown) => {
    messages.push(message);
  }) as typeof logger.info;
  try {
    client.emit("clientReady" as never);
  } finally {
    logger.info = realInfo;
  }

  assert.equal(messages.length, 1);
  assert.match(String(messages[0]), /^Logged in as /);
});
