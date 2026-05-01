import { Command } from "@sapphire/framework";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  type SlashCommandBuilder,
} from "discord.js";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  sleepCycleChanges,
  sleepCycleRuns,
  sleepCycleSettings,
} from "../../db/index.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { executeDreamPass } from "../../autonomous/sleep/index.js";
import { rollbackChange, rollbackRun } from "../../autonomous/sleep/rollback.js";

export class SleepCycleCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, { ...options, preconditions: ["AccessAllowlist"] });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    const buildBase = (builder: SlashCommandBuilder) =>
      builder
        .setName("sleep-cycle")
        .setDescription(
          "Manage the background dream pass (memory consolidation + persona growth)"
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((s) =>
          s
            .setName("enable")
            .setDescription("Enable sleep cycle for this guild")
        )
        .addSubcommand((s) =>
          s
            .setName("disable")
            .setDescription("Disable sleep cycle for this guild")
        )
        .addSubcommand((s) =>
          s
            .setName("status")
            .setDescription("Show current settings and last runs")
        )
        .addSubcommand((s) =>
          s
            .setName("run-now")
            .setDescription("Force a dream pass immediately")
            .addBooleanOption((o) =>
              o
                .setName("dry")
                .setDescription("Dry-run only (log changes, don't mutate)")
            )
        )
        .addSubcommand((s) =>
          s
            .setName("changes")
            .setDescription("List changes from a recent run")
            .addIntegerOption((o) =>
              o
                .setName("run-id")
                .setDescription("Run id to inspect")
                .setRequired(true)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("rollback")
            .setDescription("Revert changes")
            .addIntegerOption((o) =>
              o
                .setName("run-id")
                .setDescription("Revert every change in this run")
            )
            .addIntegerOption((o) =>
              o.setName("change-id").setDescription("Revert a single change")
            )
        )
        .addSubcommand((s) =>
          s
            .setName("set-dry-run")
            .setDescription(
              "Whether runs write to live tables or only log changes"
            )
            .addBooleanOption((o) =>
              o
                .setName("value")
                .setDescription("true or false")
                .setRequired(true)
            )
        )
        .addSubcommand((s) =>
          s
            .setName("set-auto-skills")
            .setDescription(
              "Allow the sleep cycle to author new skills onto disk"
            )
            .addBooleanOption((o) =>
              o
                .setName("value")
                .setDescription("true or false")
                .setRequired(true)
            )
        );

    if (env.GUILD_ID) {
      registry.registerChatInputCommand((b) => buildBase(b), {
        guildIds: [env.GUILD_ID],
      });
    } else {
      registry.registerChatInputCommand((b) =>
        buildBase(b)
          .setIntegrationTypes([ApplicationIntegrationType.GuildInstall])
          .setContexts([InteractionContextType.Guild])
      );
    }
  }

  public override async chatInputRun(
    interaction: Command.ChatInputCommandInteraction
  ) {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        content: "The sleep cycle is guild-scoped. Run this inside a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const sub = interaction.options.getSubcommand(true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    switch (sub) {
      case "enable":
        return this.handleEnable(interaction, guildId);
      case "disable":
        return this.handleDisable(interaction, guildId);
      case "status":
        return this.handleStatus(interaction, guildId);
      case "run-now":
        return this.handleRunNow(interaction, guildId);
      case "changes":
        return this.handleChanges(interaction, guildId);
      case "rollback":
        return this.handleRollback(interaction, guildId);
      case "set-dry-run":
        return this.handleSet(
          interaction,
          guildId,
          "dryRun",
          interaction.options.getBoolean("value", true)
        );
      case "set-auto-skills":
        return this.handleSet(
          interaction,
          guildId,
          "autoAuthorSkills",
          interaction.options.getBoolean("value", true)
        );
    }
  }

  private async upsert(
    guildId: string,
    patch: Partial<typeof sleepCycleSettings.$inferInsert>
  ) {
    await db
      .insert(sleepCycleSettings)
      .values({ guildId, ...patch })
      .onConflictDoUpdate({
        target: sleepCycleSettings.guildId,
        set: { ...patch, updatedAt: new Date() },
      });
  }

  private async handleEnable(
    interaction: Command.ChatInputCommandInteraction,
    guildId: string
  ) {
    await this.upsert(guildId, { enabled: true, dryRun: true });
    await interaction.editReply(
      "Sleep cycle enabled in dry-run mode. Use `/sleep-cycle set-dry-run value:false` to let it mutate state."
    );
  }

  private async handleDisable(
    interaction: Command.ChatInputCommandInteraction,
    guildId: string
  ) {
    await this.upsert(guildId, { enabled: false });
    await interaction.editReply("Sleep cycle disabled.");
  }

  private async handleStatus(
    interaction: Command.ChatInputCommandInteraction,
    guildId: string
  ) {
    const [settings] = await db
      .select()
      .from(sleepCycleSettings)
      .where(eq(sleepCycleSettings.guildId, guildId))
      .limit(1);

    const runs = await db
      .select({
        id: sleepCycleRuns.id,
        status: sleepCycleRuns.status,
        dryRun: sleepCycleRuns.dryRun,
        startedAt: sleepCycleRuns.startedAt,
        finishedAt: sleepCycleRuns.finishedAt,
        trigger: sleepCycleRuns.triggerReason,
      })
      .from(sleepCycleRuns)
      .where(eq(sleepCycleRuns.guildId, guildId))
      .orderBy(desc(sleepCycleRuns.startedAt))
      .limit(5);

    const lines: string[] = [];
    if (!settings) {
      lines.push("Sleep cycle is not configured for this guild.");
    } else {
      lines.push(
        `**Enabled**: ${settings.enabled} · **Dry run**: ${settings.dryRun} · **Auto skills**: ${settings.autoAuthorSkills}`,
        `**Activity gate**: <= ${settings.minInactiveMessages} msgs in last ${settings.lowActivityMinutes}m`,
        `**Max runs/day**: ${settings.maxRunsPerDay}`,
        `**Last run**: ${settings.lastRunAt?.toISOString() ?? "never"} · **Next eligible**: ${settings.nextEligibleAt?.toISOString() ?? "unknown"}`
      );
    }

    if (runs.length > 0) {
      lines.push("", "**Recent runs**:");
      for (const r of runs) {
        lines.push(
          `- #${r.id} [${r.status}${r.dryRun ? ", dry" : ""}] ${r.trigger ?? "-"} — started ${r.startedAt.toISOString()}`
        );
      }
    }

    await interaction.editReply(lines.join("\n"));
  }

  private async handleRunNow(
    interaction: Command.ChatInputCommandInteraction,
    guildId: string
  ) {
    const forceDry = interaction.options.getBoolean("dry") ?? undefined;
    logger.info(`sleep: manual run-now by ${interaction.user.id}`, { guildId });

    const result = await executeDreamPass({
      guildId,
      triggerReason: "manual",
      forceDryRun: forceDry,
    });

    const statsLines = Object.entries(result.phaseStats).map(
      ([phase, stats]) =>
        `- ${phase}: ${
          Object.entries(stats)
            .map(([k, v]) => `${k}=${v}`)
            .join(" ") || "(no activity)"
        }`
    );

    await interaction.editReply(
      [
        `Run #${result.runId} ${result.status}.`,
        ...(statsLines.length ? ["", "**Phase stats**:", ...statsLines] : []),
        ...(result.error ? ["", `Error: ${result.error}`] : []),
      ].join("\n")
    );
  }

  private async handleChanges(
    interaction: Command.ChatInputCommandInteraction,
    guildId: string
  ) {
    const runId = interaction.options.getInteger("run-id", true);
    // verify the run belongs to this guild
    const [run] = await db
      .select()
      .from(sleepCycleRuns)
      .where(
        and(eq(sleepCycleRuns.id, runId), eq(sleepCycleRuns.guildId, guildId))
      )
      .limit(1);
    if (!run) {
      await interaction.editReply(`Run #${runId} not found for this guild.`);
      return;
    }

    const changes = await db
      .select()
      .from(sleepCycleChanges)
      .where(eq(sleepCycleChanges.runId, runId))
      .orderBy(desc(sleepCycleChanges.id))
      .limit(25);

    if (changes.length === 0) {
      await interaction.editReply(`Run #${runId} had no recorded changes.`);
      return;
    }

    const lines = changes.map((c) => {
      const marker = c.reverted ? "↩︎ " : "• ";
      const after = c.after
        ? ` → ${JSON.stringify(c.after).slice(0, 180)}`
        : "";
      return `${marker}#${c.id} [${c.kind}]${c.targetId ? ` target=${c.targetId}` : ""}${after}`;
    });

    const body = [`Run #${runId} changes:`, ...lines].join("\n");
    await interaction.editReply(
      body.length > 1900 ? `${body.slice(0, 1900)}…` : body
    );
  }

  private async handleRollback(
    interaction: Command.ChatInputCommandInteraction,
    guildId: string
  ) {
    const runId = interaction.options.getInteger("run-id") ?? null;
    const changeId = interaction.options.getInteger("change-id") ?? null;

    if ((runId === null) === (changeId === null)) {
      await interaction.editReply(
        "Provide exactly one of `run-id` or `change-id`."
      );
      return;
    }

    if (runId !== null) {
      const [run] = await db
        .select()
        .from(sleepCycleRuns)
        .where(
          and(eq(sleepCycleRuns.id, runId), eq(sleepCycleRuns.guildId, guildId))
        )
        .limit(1);
      if (!run) {
        await interaction.editReply(`Run #${runId} not found for this guild.`);
        return;
      }
      const result = await rollbackRun(runId);
      await interaction.editReply(
        `Reverted ${result.reverted} · skipped ${result.skipped}${result.errors.length ? ` · errors: ${result.errors.join("; ")}` : ""}`
      );
      return;
    }

    if (changeId !== null) {
      // verify change belongs to a run in this guild
      const [row] = await db
        .select({ runGuild: sleepCycleRuns.guildId })
        .from(sleepCycleChanges)
        .leftJoin(
          sleepCycleRuns,
          eq(sleepCycleChanges.runId, sleepCycleRuns.id)
        )
        .where(eq(sleepCycleChanges.id, changeId))
        .limit(1);
      if (!row || row.runGuild !== guildId) {
        await interaction.editReply(
          `Change #${changeId} not found for this guild.`
        );
        return;
      }
      const result = await rollbackChange(changeId);
      await interaction.editReply(
        `Reverted ${result.reverted} · skipped ${result.skipped}${result.errors.length ? ` · errors: ${result.errors.join("; ")}` : ""}`
      );
    }
  }

  private async handleSet(
    interaction: Command.ChatInputCommandInteraction,
    guildId: string,
    key: "dryRun" | "autoAuthorSkills",
    value: boolean
  ) {
    await this.upsert(guildId, { [key]: value });
    await interaction.editReply(`Set \`${key}\` = \`${value}\`.`);
  }
}
