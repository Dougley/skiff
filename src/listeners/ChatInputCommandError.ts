import {
  type ChatInputCommandErrorPayload,
  Events,
  Listener,
} from "@sapphire/framework";
import { logger } from "../logger/index.js";

export class ChatInputCommandErrorListener extends Listener {
  public constructor(
    context: Listener.LoaderContext,
    options: Listener.Options
  ) {
    super(context, {
      ...options,
      event: Events.ChatInputCommandError,
    });
  }

  public async run(
    error: Error,
    { interaction, command }: ChatInputCommandErrorPayload
  ) {
    logger.error(`Chat input command error in /${command.name}`, {
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
        .reply({ content: message, ephemeral: true })
        .catch(() => {});
    }
  }
}
