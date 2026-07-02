import { Command } from "@sapphire/framework";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord.js";
import { and, desc, eq } from "drizzle-orm";
import { topicScopeFilter } from "../../ai/tools/topic.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { db, topicKnowledge } from "../../db/index.js";
import { CommandHintKey } from "../command-id-hints.js";

export class TopicCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, {
      ...options,
      preconditions: ["AccessAllowlist"],
      idHintKey: CommandHintKey.Topic,
    });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    const buildBase = (builder: import("discord.js").SlashCommandBuilder) =>
      builder
        .setName("topic")
        .setDescription("Manage stored topic knowledge")
        .addSubcommand((sub) =>
          sub.setName("list").setDescription("View all stored topic summaries")
        )
        .addSubcommand((sub) =>
          sub
            .setName("forget")
            .setDescription("Remove a specific topic by its number")
            .addIntegerOption((opt) =>
              opt
                .setName("number")
                .setDescription("The topic number from /topic list to remove")
                .setRequired(true)
                .setMinValue(1)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("forget-all")
            .setDescription("Remove all stored topic knowledge")
        );

    if (env.GUILD_ID) {
      registry.registerChatInputCommand((builder) => buildBase(builder), {
        guildIds: [env.GUILD_ID],
      });
    } else {
      registry.registerChatInputCommand((builder) =>
        buildBase(builder)
          .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
          .setContexts([InteractionContextType.Guild])
      );
    }

    registry.registerChatInputCommand((builder) =>
      buildBase(builder)
        .setIntegrationTypes([ApplicationIntegrationType.UserInstall])
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
    const sub = interaction.options.getSubcommand(true);

    switch (sub) {
      case "list":
        return this.handleList(interaction);
      case "forget":
        return this.handleForget(interaction);
      case "forget-all":
        return this.handleForgetAll(interaction);
    }
  }

  private async handleList(interaction: Command.ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const scopeFilter = topicScopeFilter(
      interaction.guildId,
      interaction.channelId
    );

    const rows = await db
      .select({
        id: topicKnowledge.id,
        title: topicKnowledge.title,
        summary: topicKnowledge.summary,
        tags: topicKnowledge.tags,
      })
      .from(topicKnowledge)
      .where(and(eq(topicKnowledge.active, true), scopeFilter))
      .orderBy(desc(topicKnowledge.updatedAt));

    if (rows.length === 0) {
      await interaction.editReply("No topic knowledge stored yet.");
      return;
    }

    const lines = rows.map((row, i) => {
      const tags = row.tags.length > 0 ? ` [${row.tags.join(", ")}]` : "";
      return `**${i + 1}.** ${row.title}${tags}\n> ${row.summary.slice(0, 100)}${row.summary.length > 100 ? "…" : ""}`;
    });

    const text = `Stored topics (${rows.length}):\n\n${lines.join("\n\n")}\n\n-# Use \`/topic forget <number>\` to remove a topic.`;

    // Discord has a 2000 char limit; truncate if needed
    await interaction.editReply(
      text.length > 2000 ? `${text.slice(0, 1997)}…` : text
    );
  }

  private async handleForget(interaction: Command.ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const number = interaction.options.getInteger("number", true);
    const scopeFilter = topicScopeFilter(
      interaction.guildId,
      interaction.channelId
    );

    const rows = await db
      .select({ id: topicKnowledge.id, title: topicKnowledge.title })
      .from(topicKnowledge)
      .where(and(eq(topicKnowledge.active, true), scopeFilter))
      .orderBy(desc(topicKnowledge.updatedAt));

    if (number < 1 || number > rows.length) {
      await interaction.editReply(
        `Invalid number. You have ${rows.length} topic${rows.length === 1 ? "" : "s"}. Use \`/topic list\` to see them.`
      );
      return;
    }

    const target = rows[number - 1];

    if (!target) {
      await interaction.editReply(
        `Invalid number. You have ${rows.length} topic${rows.length === 1 ? "" : "s"}. Use \`/topic list\` to see them.`
      );
      return;
    }

    await db
      .update(topicKnowledge)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(topicKnowledge.id, target.id));

    logger.info(
      `User ${interaction.user.id} forgot topic #${target.id}: "${target.title}"`
    );

    await interaction.editReply(`Forgotten: *${target.title}*`);
  }

  private async handleForgetAll(
    interaction: Command.ChatInputCommandInteraction
  ) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const scopeFilter = topicScopeFilter(
      interaction.guildId,
      interaction.channelId
    );

    const result = await db
      .update(topicKnowledge)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(topicKnowledge.active, true), scopeFilter))
      .returning({ id: topicKnowledge.id });

    if (result.length === 0) {
      await interaction.editReply("No topic knowledge stored.");
      return;
    }

    logger.info(
      `User ${interaction.user.id} forgot all topics (${result.length} deactivated)`
    );

    await interaction.editReply(
      `Done — forgot ${result.length} topic${result.length === 1 ? "" : "s"}.`
    );
  }
}
