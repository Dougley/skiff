import { Command } from "@sapphire/framework";
import { MessageFlags } from "discord.js";
import { deleteConversation } from "../db/queries.js";
import { env } from "../env/index.js";
import { logger } from "../logger/index.js";

export class ClearCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, preconditions: ["AccessAllowlist"] });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand(
      (builder) => {
        builder
          .setName("clear")
          .setDescription("Clear the conversation history in this channel");
      },
      {
        guildIds: env.GUILD_ID ? [env.GUILD_ID] : undefined,
      }
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
