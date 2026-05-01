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
  baseUserDirectory: "src/discord",
});

export async function startClient() {
  await client.login(env.DISCORD_BOT_TOKEN);
}

client.once("clientReady", () => {
  logger.info(`Logged in as ${client.user?.tag}`);
});

export { client };
