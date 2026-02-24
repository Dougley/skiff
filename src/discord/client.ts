import { SapphireClient } from "@sapphire/framework";
import { GatewayIntentBits, Partials } from "discord.js";
import { env } from "../env/index.js";
import { logger } from "../logger/index.js";

const client = new SapphireClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

export async function startClient() {
  await client.login(env.DISCORD_BOT_TOKEN);
}

client.once("clientReady", () => {
  logger.info(`Logged in as ${client.user?.tag}`);
});

export { client };
