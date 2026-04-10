import { Command } from "@sapphire/framework";
import { MessageFlags, TextDisplayBuilder } from "discord.js";
import { env } from "../env/index.js";
import { handleConversationTurn } from "../llm/conversation-turn.js";
import { logger } from "../logger/index.js";

export class AskCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, preconditions: ["AccessAllowlist"] });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand(
      (builder) => {
        builder
          .setName("ask")
          .setDescription("Ask a question to the AI assistant")
          .addStringOption((option) =>
            option
              .setName("question")
              .setDescription("Your question for the assistant")
              .setRequired(true)
          );
      },
      {
        guildIds: env.GUILD_ID ? [env.GUILD_ID] : undefined,
      }
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
      components: first,
    });

    for (const chunk of rest) {
      await interaction.followUp({
        flags: MessageFlags.IsComponentsV2,
        components: chunk,
      });
    }
    logger.info(
      `Replied to /ask command from user ${interaction.user.id} with assistant response, convo length so far: ${result.historyLength} messages`
    );
  }
}
