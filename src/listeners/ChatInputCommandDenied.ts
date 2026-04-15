import {
  type ChatInputCommandDeniedPayload,
  Events,
  Listener,
  type UserError,
} from "@sapphire/framework";
import { MessageFlags } from "discord.js";
import { logger } from "../logger/index.js";

export class ChatInputCommandDeniedListener extends Listener {
  public constructor(
    context: Listener.LoaderContext,
    options: Listener.Options
  ) {
    super(context, {
      ...options,
      event: Events.ChatInputCommandDenied,
    });
  }

  public async run(
    error: UserError,
    { interaction, command }: ChatInputCommandDeniedPayload
  ) {
    logger.debug(`Chat input command denied for /${command.name}`, {
      reason: error.message,
      userId: interaction.user.id,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
    });

    const message = "Access denied.";

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction
        .reply({ content: message, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
}
