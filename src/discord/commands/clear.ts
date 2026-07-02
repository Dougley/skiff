import { Command } from "@sapphire/framework";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  type SlashCommandBuilder,
} from "discord.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { deleteConversation } from "../../db/queries.js";
import { CommandHintKey } from "../command-id-hints.js";

export class ClearCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, {
      ...options,
      preconditions: ["AccessAllowlist"],
      idHintKey: CommandHintKey.Clear,
    });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    const buildBase = (builder: SlashCommandBuilder) =>
      builder
        .setName("clear")
        .setDescription("Clear the conversation history in this channel");

    if (env.GUILD_ID) {
      registry.registerChatInputCommand((builder) => buildBase(builder), {
        guildIds: [env.GUILD_ID],
      });
    }

    // one global registration carrying both install types — registering the
    // same name twice with different integration types makes Sapphire PATCH
    // the command back and forth on every boot
    registry.registerChatInputCommand((builder) =>
      buildBase(builder)
        .setIntegrationTypes([
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        ])
        .setContexts([
          InteractionContextType.Guild,
          InteractionContextType.BotDM,
          InteractionContextType.PrivateChannel,
        ])
    );
  }

  public override async chatInputRun(
    interaction: Command.ChatInputCommandInteraction
  ) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const deleted = await deleteConversation({
      channelId: interaction.channelId,
      guildId: interaction.guildId,
    });

    if (deleted) {
      logger.info(
        `Cleared conversation in channel ${interaction.channelId} by user ${interaction.user.id}`
      );
      await interaction.editReply("Conversation cleared.");
    } else {
      await interaction.editReply("No conversation to clear in this channel.");
    }
  }
}
