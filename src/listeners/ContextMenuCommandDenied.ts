import {
  type ContextMenuCommandDeniedPayload,
  Events,
  Listener,
  type UserError,
} from "@sapphire/framework";
import { MessageFlags } from "discord.js";
import { logger } from "../logger/index.js";

export class ContextMenuCommandDeniedListener extends Listener {
  public constructor(
    context: Listener.LoaderContext,
    options: Listener.Options
  ) {
    super(context, {
      ...options,
      event: Events.ContextMenuCommandDenied,
    });
  }

  public async run(
    error: UserError,
    { interaction, command }: ContextMenuCommandDeniedPayload
  ) {
    logger.debug(`Context menu command denied for ${command.name}`, {
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
