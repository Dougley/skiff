import {
  type ContextMenuCommandErrorPayload,
  Events,
  Listener,
} from "@sapphire/framework";
import { MessageFlags } from "discord.js";
import { logger } from "../../config/logger.js";

export class ContextMenuCommandErrorListener extends Listener {
  public constructor(
    context: Listener.LoaderContext,
    options: Listener.Options
  ) {
    super(context, {
      ...options,
      event: Events.ContextMenuCommandError,
    });
  }

  public async run(
    error: Error,
    { interaction, command }: ContextMenuCommandErrorPayload
  ) {
    logger.error(`Context menu command error in ${command.name}`, {
      err: error,
      userId: interaction.user.id,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
    });

    const message = "Something went wrong — try again in a moment.";

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction
        .reply({ content: message, flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
  }
}
