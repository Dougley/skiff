import { Command } from "@sapphire/framework";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  type SlashCommandBuilder,
} from "discord.js";
import { and, desc, eq } from "drizzle-orm";
import { executeDreamPass } from "../../autonomous/sleep/index.js";
import {
  rollbackChange,
  rollbackRun,
} from "../../autonomous/sleep/rollback.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import {
  db,
  sleepCycleChanges,
  sleepCycleRuns,
  sleepCycleSettings,
} from "../../db/index.js";
import { CommandHintKey } from "../command-id-hints.js";

// a dream scope is exactly one of: a guild, or a DM channel
type SleepScope = { guildId: string | null; channelId: string | null };

export class SleepCycleCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, {
      ...options,
      preconditions: ["AccessAllowlist"],
      idHintKey: CommandHintKey.SleepCycle,
    });
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
        )
        .addSubcommand((s) =>
          s
            .setName("set-report-channel")
            .setDescription(
              "Post a digest after each scheduled dream pass (omit channel to disable)"
            )
            .addChannelOption((o) =>
              o.setName("channel").setDescription("Channel for dream reports")
            )
        );

    if (env.GUILD_ID) {
      registry.registerChatInputCommand((b) => buildBase(b), {
        guildIds: [env.GUILD_ID],
      });
    }

    // one global registration carrying both install types — registering the
    // same name twice with different integration types makes Sapphire PATCH
    // the command back and forth on every boot
    registry.registerChatInputCommand((b) =>
      buildBase(b)
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
    // guild channels dream at guild scope; DMs dream at channel scope
    const scope: SleepScope = interaction.guildId
      ? { guildId: interaction.guildId, channelId: null }
      : { guildId: null, channelId: interaction.channelId };

    const sub = interaction.options.getSubcommand(true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    switch (sub) {
      case "enable":
        return this.handleEnable(interaction, scope);
      case "disable":
        return this.handleDisable(interaction, scope);
      case "status":
        return this.handleStatus(interaction, scope);
      case "run-now":
        return this.handleRunNow(interaction, scope);
      case "changes":
        return this.handleChanges(interaction, scope);
      case "rollback":
        return this.handleRollback(interaction, scope);
      case "set-dry-run":
        return this.handleSet(
          interaction,
          scope,
          "dryRun",
          interaction.options.getBoolean("value", true)
        );
      case "set-auto-skills":
        return this.handleSet(
          interaction,
          scope,
          "autoAuthorSkills",
          interaction.options.getBoolean("value", true)
        );
      case "set-report-channel":
        return this.handleSetReportChannel(interaction, scope);
    }
  }

  private settingsFilter(scope: SleepScope) {
    return scope.guildId
      ? eq(sleepCycleSettings.guildId, scope.guildId)
      : eq(sleepCycleSettings.channelId, scope.channelId as string);
  }

  private runsFilter(scope: SleepScope) {
    return scope.guildId
      ? eq(sleepCycleRuns.guildId, scope.guildId)
      : eq(sleepCycleRuns.channelId, scope.channelId as string);
  }

  private async handleSetReportChannel(
    interaction: Command.ChatInputCommandInteraction,
    scope: SleepScope
  ) {
    // omitting the channel disables reports (DM enables default them back on)
    const channel = interaction.options.getChannel("channel");
    await this.upsert(scope, { reportChannelId: channel?.id ?? null });
    await interaction.editReply(
      channel
        ? `Dream reports will be posted to <#${channel.id}> after each scheduled pass.`
        : "Dream reports disabled."
    );
  }

  private async upsert(
    scope: SleepScope,
    patch: Partial<typeof sleepCycleSettings.$inferInsert>
  ) {
    const updated = await db
      .update(sleepCycleSettings)
      .set({ ...patch, updatedAt: new Date() })
      .where(this.settingsFilter(scope))
      .returning({ enabled: sleepCycleSettings.enabled });
    if (updated.length === 0) {
      await db.insert(sleepCycleSettings).values({
        guildId: scope.guildId,
        channelId: scope.channelId,
        ...patch,
      });
    }
  }

  private async handleEnable(
    interaction: Command.ChatInputCommandInteraction,
    scope: SleepScope
  ) {
    await this.upsert(scope, {
      enabled: true,
      dryRun: true,
      // DM dreams report into the DM itself by default
      ...(scope.channelId ? { reportChannelId: scope.channelId } : {}),
    });
    await interaction.editReply(
      "Sleep cycle enabled in dry-run mode. Use `/sleep-cycle set-dry-run value:false` to let it mutate state."
    );
  }

  private async handleDisable(
    interaction: Command.ChatInputCommandInteraction,
    scope: SleepScope
  ) {
    await this.upsert(scope, { enabled: false });
    await interaction.editReply("Sleep cycle disabled.");
  }

  private async handleStatus(
    interaction: Command.ChatInputCommandInteraction,
    scope: SleepScope
  ) {
    const [settings] = await db
      .select()
      .from(sleepCycleSettings)
      .where(this.settingsFilter(scope))
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
      .where(this.runsFilter(scope))
      .orderBy(desc(sleepCycleRuns.startedAt))
      .limit(5);

    const lines: string[] = [];
    if (!settings) {
      lines.push(
        `Sleep cycle is not configured for this ${scope.guildId ? "guild" : "DM"}.`
      );
    } else {
      lines.push(
        `**Enabled**: ${settings.enabled} · **Dry run**: ${settings.dryRun} · **Auto skills**: ${settings.autoAuthorSkills} · **Reports**: ${settings.reportChannelId ? `<#${settings.reportChannelId}>` : "off"}`,
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
    scope: SleepScope
  ) {
    const forceDry = interaction.options.getBoolean("dry") ?? undefined;
    logger.info(`sleep: manual run-now by ${interaction.user.id}`, {
      guildId: scope.guildId,
      channelId: scope.channelId,
    });

    const result = await executeDreamPass({
      guildId: scope.guildId,
      channelId: scope.channelId,
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
    scope: SleepScope
  ) {
    const runId = interaction.options.getInteger("run-id", true);
    // verify the run belongs to this scope
    const [run] = await db
      .select()
      .from(sleepCycleRuns)
      .where(and(eq(sleepCycleRuns.id, runId), this.runsFilter(scope)))
      .limit(1);
    if (!run) {
      await interaction.editReply(`Run #${runId} not found for this scope.`);
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
    scope: SleepScope
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
        .where(and(eq(sleepCycleRuns.id, runId), this.runsFilter(scope)))
        .limit(1);
      if (!run) {
        await interaction.editReply(`Run #${runId} not found for this scope.`);
        return;
      }
      const result = await rollbackRun(runId);
      await interaction.editReply(
        `Reverted ${result.reverted} · skipped ${result.skipped}${result.errors.length ? ` · errors: ${result.errors.join("; ")}` : ""}`
      );
      return;
    }

    if (changeId !== null) {
      // verify change belongs to a run in this scope
      const [row] = await db
        .select({
          runGuild: sleepCycleRuns.guildId,
          runChannel: sleepCycleRuns.channelId,
        })
        .from(sleepCycleChanges)
        .leftJoin(
          sleepCycleRuns,
          eq(sleepCycleChanges.runId, sleepCycleRuns.id)
        )
        .where(eq(sleepCycleChanges.id, changeId))
        .limit(1);
      if (
        !row ||
        row.runGuild !== scope.guildId ||
        row.runChannel !== scope.channelId
      ) {
        await interaction.editReply(
          `Change #${changeId} not found for this scope.`
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
    scope: SleepScope,
    key: "dryRun" | "autoAuthorSkills",
    value: boolean
  ) {
    await this.upsert(scope, { [key]: value });
    await interaction.editReply(`Set \`${key}\` = \`${value}\`.`);
  }
}
