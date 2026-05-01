import { Command } from "@sapphire/framework";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord.js";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db, userFacts } from "../../db/index.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

export class MemoryCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, preconditions: ["AccessAllowlist"] });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    const buildBase = (builder: import("discord.js").SlashCommandBuilder) =>
      builder
        .setName("memory")
        .setDescription("Manage what the bot remembers about you")
        .addSubcommand((sub) =>
          sub
            .setName("list")
            .setDescription("View all facts the bot remembers about you")
        )
        .addSubcommand((sub) =>
          sub
            .setName("forget")
            .setDescription("Remove a specific fact by its number")
            .addIntegerOption((opt) =>
              opt
                .setName("number")
                .setDescription("The fact number from /memory list to remove")
                .setRequired(true)
                .setMinValue(1)
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("forget-all")
            .setDescription("Remove all facts the bot remembers about you")
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

    const guildId = interaction.guildId;
    const guildFilter = guildId
      ? or(eq(userFacts.guildId, guildId), sql`${userFacts.guildId} is null`)
      : sql`${userFacts.guildId} is null`;

    const rows = await db
      .select({
        id: userFacts.id,
        fact: userFacts.fact,
        category: userFacts.category,
      })
      .from(userFacts)
      .where(
        and(
          eq(userFacts.userId, interaction.user.id),
          eq(userFacts.active, true),
          guildFilter
        )
      )
      .orderBy(desc(userFacts.updatedAt));

    if (rows.length === 0) {
      await interaction.editReply("I don't have any facts stored about you.");
      return;
    }

    const lines = rows.map((row, i) => {
      const cat = row.category ? ` [${row.category}]` : "";
      return `**${i + 1}.** ${row.fact}${cat}`;
    });

    const suffix = "\n\n-# Use `/memory forget <number>` to remove a fact.";
    const text = `Here's what I remember about you:\n\n${lines.join("\n")}${suffix}`;

    await interaction.editReply(
      text.length > 2000
        ? `${text.slice(0, 2000 - suffix.length - 1)}…${suffix}`
        : text
    );
  }

  private async handleForget(interaction: Command.ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const number = interaction.options.getInteger("number", true);
    const guildId = interaction.guildId;
    const guildFilter = guildId
      ? or(eq(userFacts.guildId, guildId), sql`${userFacts.guildId} is null`)
      : sql`${userFacts.guildId} is null`;

    const rows = await db
      .select({ id: userFacts.id, fact: userFacts.fact })
      .from(userFacts)
      .where(
        and(
          eq(userFacts.userId, interaction.user.id),
          eq(userFacts.active, true),
          guildFilter
        )
      )
      .orderBy(desc(userFacts.updatedAt));

    if (number < 1 || number > rows.length) {
      await interaction.editReply(
        `Invalid number. You have ${rows.length} fact${rows.length === 1 ? "" : "s"}. Use \`/memory list\` to see them.`
      );
      return;
    }

    const target = rows[number - 1];

    if (!target) {
      await interaction.editReply(
        `Invalid number. You have ${rows.length} fact${rows.length === 1 ? "" : "s"}. Use \`/memory list\` to see them.`
      );
      return;
    }

    await db
      .update(userFacts)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(userFacts.id, target.id));

    logger.info(
      `User ${interaction.user.id} forgot fact #${target.id}: "${target.fact}"`
    );

    await interaction.editReply(`Forgotten: *${target.fact}*`);
  }

  private async handleForgetAll(
    interaction: Command.ChatInputCommandInteraction
  ) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guildId;
    const guildFilter = guildId
      ? or(eq(userFacts.guildId, guildId), sql`${userFacts.guildId} is null`)
      : sql`${userFacts.guildId} is null`;

    const result = await db
      .update(userFacts)
      .set({ active: false, updatedAt: new Date() })
      .where(
        and(
          eq(userFacts.userId, interaction.user.id),
          eq(userFacts.active, true),
          guildFilter
        )
      )
      .returning({ id: userFacts.id });

    if (result.length === 0) {
      await interaction.editReply("I don't have any facts stored about you.");
      return;
    }

    logger.info(
      `User ${interaction.user.id} forgot all facts (${result.length} deactivated)`
    );

    await interaction.editReply(
      `Done — forgot ${result.length} fact${result.length === 1 ? "" : "s"} about you.`
    );
  }
}
