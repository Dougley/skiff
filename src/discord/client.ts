import { SapphireClient } from "@sapphire/framework";
import { GatewayIntentBits, Partials } from "discord.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";

const client = new SapphireClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
  baseUserDirectory:
    env.NODE_ENV === "production"
      ? // be exact, for precision and to avoid any potential issues with relative paths in production
        new URL("../../dist/discord", import.meta.url).pathname
      : // in development, we want to use the source files directly for easier debugging
        new URL("../../src/discord", import.meta.url).pathname,
});

export async function startClient() {
  await client.login(env.DISCORD_BOT_TOKEN);
}

client.once("clientReady", () => {
  logger.info(`Logged in as ${client.user?.tag}`);
});

export { client };
