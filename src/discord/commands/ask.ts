import { Command } from "@sapphire/framework";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  type SlashCommandBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { handleConversationTurn } from "../../ai/llm/conversation-turn.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { CommandHintKey } from "../command-id-hints.js";

export class AskCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, {
      ...options,
      preconditions: ["AccessAllowlist"],
      idHintKey: CommandHintKey.Ask,
    });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    const buildBase = (builder: SlashCommandBuilder) =>
      builder
        .setName("ask")
        .setDescription("Ask a question to the AI assistant")
        .addStringOption((option) =>
          option
            .setName("question")
            .setDescription("Your question for the assistant")
            .setRequired(true)
        );

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
    logger.info(
      `Received /ask command from user ${interaction.user.id} in guild ${interaction.guildId}, channel ${interaction.channelId}`
    );
    await interaction.deferReply();

    const question = interaction.options.getString("question", true);
    const channel = interaction.channel;
    const channelName =
      channel && "name" in channel ? `#${channel.name}` : "DM";
    const member = interaction.guild
      ? await interaction.guild.members
          .fetch(interaction.user.id)
          .catch(() => null)
      : null;

    const result = await handleConversationTurn({
      content: question,
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
    logger.info(
      `Replied to /ask command from user ${interaction.user.id} with assistant response, convo length so far: ${result.historyLength} messages`
    );
  }
}
