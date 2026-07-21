import { Command } from "@sapphire/framework";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
} from "discord.js";
import { getWake } from "../../ai/logbook/store.js";
import { env } from "../../config/env.js";
import { CommandHintKey } from "../command-id-hints.js";

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const RELATION_LABELS: Record<string, string> = {
  supports: "supports",
  depends_on: "depends on",
  contradicts: "contradicts",
  supersedes: "supersedes",
  caused_by: "was caused by",
};

export class WakeCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, {
      ...options,
      preconditions: ["AccessAllowlist"],
      idHintKey: CommandHintKey.Wake,
    });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    const buildBase = (builder: import("discord.js").SlashCommandBuilder) =>
      builder
        .setName("wake")
        .setDescription("Trace why a Logbook event exists")
        .addIntegerOption((option) =>
          option
            .setName("event")
            .setDescription("The event ID shown by /logbook show")
            .setRequired(true)
            .setMinValue(1)
        )
        .addIntegerOption((option) =>
          option
            .setName("depth")
            .setDescription("How many connections to follow (default 3)")
            .setMinValue(1)
            .setMaxValue(4)
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
    const eventId = interaction.options.getInteger("event", true);
    const depth = interaction.options.getInteger("depth") ?? 3;
    const graph = await getWake(
      { guildId: interaction.guildId, channelId: interaction.channelId },
      eventId,
      depth
    );
    if (!graph) {
      await interaction.editReply("That event isn't in this Logbook.");
      return;
    }

    const byId = new Map(graph.nodes.map((node) => [node.event.id, node]));
    const root = byId.get(eventId);
    if (!root) {
      await interaction.editReply("That event isn't in this Logbook.");
      return;
    }
    const connections = graph.links.length
      ? graph.links
          .map((link) => {
            const from = byId.get(link.fromEventId);
            const to = byId.get(link.toEventId);
            const rationale = link.rationale
              ? `\n> ${truncate(link.rationale, 180)}`
              : "";
            return `**#${link.fromEventId}** ${RELATION_LABELS[link.relation] ?? link.relation} **#${link.toEventId}**${rationale}\n-# ${from?.event.summary ?? "Unknown event"} → ${to?.event.summary ?? "Unknown event"}`;
          })
          .join("\n\n")
      : "No causal links have been recorded yet.";
    const evidence = root.evidence.length
      ? root.evidence
          .map(
            (source) =>
              `> ${truncate(source.excerpt.replaceAll("\n", " "), 260)}${source.note ? `\n-# ${source.note}` : ""}`
          )
          .join("\n")
      : "No source messages are attached.";

    const text = [
      `## The Wake of event #${eventId}`,
      `**${root.event.kind.replaceAll("_", " ")} · ${root.storyline.title}**`,
      root.event.summary,
      `\n### Connections\n${connections}`,
      `\n### Evidence\n${evidence}`,
    ].join("\n");
    await interaction.editReply(truncate(text, 2000));
  }
}
