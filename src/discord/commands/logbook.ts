import { Command } from "@sapphire/framework";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord.js";
import {
  getStoryline,
  listStorylines,
  STORYLINE_STATUSES,
} from "../../ai/logbook/store.js";
import { env } from "../../config/env.js";
import { CommandHintKey } from "../command-id-hints.js";

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export class LogbookCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, {
      ...options,
      preconditions: ["AccessAllowlist"],
      idHintKey: CommandHintKey.Logbook,
    });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    const buildBase = (builder: import("discord.js").SlashCommandBuilder) =>
      builder
        .setName("logbook")
        .setDescription("View ongoing storylines, decisions, and open loops")
        .addSubcommand((sub) =>
          sub
            .setName("list")
            .setDescription("List Logbook storylines")
            .addBooleanOption((option) =>
              option
                .setName("include-closed")
                .setDescription("Include completed and abandoned storylines")
            )
        )
        .addSubcommand((sub) =>
          sub
            .setName("show")
            .setDescription("Show one storyline and its recent history")
            .addIntegerOption((option) =>
              option
                .setName("id")
                .setDescription("The storyline ID shown by /logbook list")
                .setRequired(true)
                .setMinValue(1)
            )
        );

    if (env.GUILD_ID) {
      registry.registerChatInputCommand((builder) => buildBase(builder), {
        guildIds: [env.GUILD_ID],
      });
    }

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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const scope = {
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    };

    if (interaction.options.getSubcommand(true) === "show") {
      const id = interaction.options.getInteger("id", true);
      const result = await getStoryline(scope, id, 12);
      if (!result) {
        await interaction.editReply("That storyline isn't in this Logbook.");
        return;
      }

      const { storyline, events } = result;
      const owners = storyline.ownerUserIds.length
        ? `\n**Owners:** ${storyline.ownerUserIds.map((owner) => `<@${owner}>`).join(", ")}`
        : "";
      const tags = storyline.tags.length
        ? `\n**Tags:** ${storyline.tags.map((tag) => `\`${tag}\``).join(" ")}`
        : "";
      const history = events.length
        ? events
            .map((event) => {
              const isOpenLoop = [
                "open_question",
                "commitment",
                "risk",
              ].includes(event.kind);
              const marker =
                event.status === "resolved" ? "✓" : isOpenLoop ? "○" : "•";
              const owner = event.ownerUserId
                ? ` · <@${event.ownerUserId}>`
                : "";
              const due = event.dueAt
                ? ` · due <t:${Math.floor(event.dueAt.getTime() / 1000)}:R>`
                : "";
              return `${marker} **#${event.id} ${event.kind.replaceAll("_", " ")}**${owner}${due}\n${truncate(event.summary, 240)}`;
            })
            .join("\n\n")
        : "No events recorded yet.";

      const text = [
        `## #${storyline.id} ${storyline.title}`,
        `**Status:** ${storyline.status}${owners}${tags}`,
        `\n**Goal**\n${storyline.goal}`,
        `\n**Current state**\n${storyline.currentState}`,
        `\n### Recent history\n${history}`,
      ].join("\n");
      await interaction.editReply(truncate(text, 2000));
      return;
    }

    const includeClosed =
      interaction.options.getBoolean("include-closed") ?? false;
    const rows = await listStorylines(
      scope,
      includeClosed ? [...STORYLINE_STATUSES] : ["open", "paused"],
      25
    );
    if (rows.length === 0) {
      await interaction.editReply(
        "The Logbook is empty. Ask me to start tracking an ongoing goal or project."
      );
      return;
    }

    const entries = rows.map((row) => {
      const owners = row.ownerUserIds.length
        ? ` · ${row.ownerUserIds.map((owner) => `<@${owner}>`).join(", ")}`
        : "";
      return `**#${row.id} ${row.title}** · ${row.status}${owners}\n> ${truncate(row.currentState, 180)}`;
    });
    const suffix = "\n\n-# Use `/logbook show <id>` for the full history.";
    await interaction.editReply(
      truncate(`## Logbook\n\n${entries.join("\n\n")}${suffix}`, 2000)
    );
  }
}
