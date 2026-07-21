import { Command } from "@sapphire/framework";
import {
  ApplicationCommandType,
  ApplicationIntegrationType,
  type ContextMenuCommandInteraction,
  InteractionContextType,
  MessageFlags,
  TextDisplayBuilder,
} from "discord.js";
import { handleConversationTurn } from "../../ai/llm/conversation-turn.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { createLatestUpdateQueue } from "../../utils/latest-update-queue.js";
import { CommandHintKey } from "../command-id-hints.js";

export class AskMessageCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, {
      ...options,
      preconditions: ["AccessAllowlist"],
      idHintKey: CommandHintKey.AskMessage,
    });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    if (env.GUILD_ID) {
      registry.registerContextMenuCommand(
        {
          name: "Ask about message",
          type: ApplicationCommandType.Message,
        },
        { guildIds: [env.GUILD_ID] }
      );
    }

    // one global registration carrying both install types — registering the
    // same name twice with different integration types makes Sapphire PATCH
    // the command back and forth on every boot
    registry.registerContextMenuCommand({
      name: "Ask about message",
      type: ApplicationCommandType.Message,
      integrationTypes: [
        ApplicationIntegrationType.GuildInstall,
        ApplicationIntegrationType.UserInstall,
      ],
      contexts: [
        InteractionContextType.Guild,
        InteractionContextType.BotDM,
        InteractionContextType.PrivateChannel,
      ],
    });
  }

  public override async contextMenuRun(
    interaction: ContextMenuCommandInteraction
  ) {
    if (!interaction.isMessageContextMenuCommand()) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "This command can only be used on a message.",
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const target = interaction.targetMessage;
    const targetAuthor = target.author;
    const targetText = target.content?.trim() || "[no text content]";
    const prompt = `Please help me with this selected message from ${targetAuthor.username} (${targetAuthor.id}):\n\n${targetText}`;

    const channel = interaction.channel;
    const channelName =
      channel && "name" in channel ? `#${channel.name}` : "DM";
    const member = interaction.guild
      ? await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null)
      : null;

    logger.info(
      `Received message context command from user ${interaction.user.id} for message ${target.id}`
    );
    const statusUpdates = createLatestUpdateQueue<string>(
      async (statusText) => {
        await interaction.editReply({
          flags: MessageFlags.IsComponentsV2,
          components: [new TextDisplayBuilder().setContent(statusText)],
        });
      },
      (err) => logger.warn("Failed to update tool status", { err })
    );

    const result = await handleConversationTurn({
      content: prompt,
      userId: interaction.user.id,
      channelId: interaction.channelId,
      guildId: interaction.guildId,
      skipInitialStatus: true,
      toolContext: {
        client: this.container.client,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        async editStatusMessage(options) {
          try {
            const msg = await interaction.editReply({
              content: options.content ?? undefined,
              components: options.components as never,
            });
            return msg;
          } catch (err) {
            logger.warn("Failed to edit status message", { err });
            return null;
          }
        },
      },
      messageContext: {
        displayName: member?.displayName ?? interaction.user.displayName,
        username: interaction.user.username,
        channelName,
        guildName: interaction.guild?.name ?? null,
        isDM: !interaction.guildId,
      },
      onToolStatus(statusText) {
        statusUpdates.push(statusText);
      },
    });

    await statusUpdates.flush();

    const [first, ...rest] = result.messages;
    if (!first) {
      await interaction.editReply({ content: "I had nothing to say." });
      return;
    }

    await interaction.editReply({
      flags: MessageFlags.IsComponentsV2,
      components: first.components,
      files: first.files,
    });

    for (const chunk of rest) {
      await interaction.followUp({
        flags: MessageFlags.IsComponentsV2,
        components: chunk.components,
        files: chunk.files,
      });
    }
  }
}
