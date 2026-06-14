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

export class AskUserCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, preconditions: ["AccessAllowlist"] });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    if (env.GUILD_ID) {
      registry.registerContextMenuCommand(
        {
          name: "Ask about user",
          type: ApplicationCommandType.User,
        },
        { guildIds: [env.GUILD_ID] }
      );
    } else {
      registry.registerContextMenuCommand({
        name: "Ask about user",
        type: ApplicationCommandType.User,
        integrationTypes: [ApplicationIntegrationType.GuildInstall],
        contexts: [InteractionContextType.Guild],
      });
    }

    registry.registerContextMenuCommand({
      name: "Ask about user",
      type: ApplicationCommandType.User,
      integrationTypes: [ApplicationIntegrationType.UserInstall],
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
    if (!interaction.isUserContextMenuCommand()) {
      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: "This command can only be used on a user.",
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const target = interaction.targetUser;
    const targetMember = interaction.guild
      ? await interaction.guild.members.fetch(target.id).catch(() => null)
      : null;
    const prompt = `Please help me with this selected user:\n\n- username: ${target.username}\n- user id: ${target.id}\n- display name: ${target.displayName}${targetMember?.displayName ? `\n- server nickname: ${targetMember.displayName}` : ""}`;

    const channel = interaction.channel;
    const channelName =
      channel && "name" in channel ? `#${channel.name}` : "DM";
    const member = interaction.guild
      ? await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null)
      : null;

    logger.info(
      `Received user context command from user ${interaction.user.id} for target ${target.id}`
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
        interaction
          .editReply({
            flags: MessageFlags.IsComponentsV2,
            components: [new TextDisplayBuilder().setContent(statusText)],
          })
          .catch((err) => logger.warn("Failed to update tool status", { err }));
      },
    });

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
