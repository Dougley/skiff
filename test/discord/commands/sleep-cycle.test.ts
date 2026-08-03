import assert from "node:assert/strict";
import { afterEach, beforeAll, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";
import {
  installFakeClient,
  lastReplyText,
  loaderContext,
  makeInteraction,
  stubRegistry,
} from "./harness.js";

vi.mock("../../../src/autonomous/sleep/index.js", () => ({
  executeDreamPass: vi.fn(),
}));
vi.mock("../../../src/autonomous/sleep/rollback.js", () => ({
  rollbackRun: vi.fn(),
  rollbackChange: vi.fn(),
}));

bootstrapTestEnv();
installFakeClient();

const { runMigrations } = await import("../../../src/db/migrate.js");
const { db, sleepCycleChanges, sleepCycleRuns, sleepCycleSettings } =
  await import("../../../src/db/index.js");
const { eq } = await import("drizzle-orm");
const { executeDreamPass } = await import(
  "../../../src/autonomous/sleep/index.js"
);
const { rollbackChange, rollbackRun } = await import(
  "../../../src/autonomous/sleep/rollback.js"
);
const { env } = await import("../../../src/config/env.js");
const { PermissionFlagsBits } = await import("discord.js");
const { SleepCycleCommand } = await import(
  "../../../src/discord/commands/sleep-cycle.js"
);

const dreamPass = vi.mocked(executeDreamPass);
const runRollback = vi.mocked(rollbackRun);
const changeRollback = vi.mocked(rollbackChange);
const command = new SleepCycleCommand(loaderContext("sleep-cycle"), {});

beforeAll(async () => {
  await runMigrations();
});

afterEach(() => {
  dreamPass.mockReset();
  runRollback.mockReset();
  changeRollback.mockReset();
  env.GUILD_ID = undefined;
});

const guildSettings = async (guildId: string) =>
  (
    await db
      .select()
      .from(sleepCycleSettings)
      .where(eq(sleepCycleSettings.guildId, guildId))
  )[0];

const channelSettings = async (channelId: string) =>
  (
    await db
      .select()
      .from(sleepCycleSettings)
      .where(eq(sleepCycleSettings.channelId, channelId))
  )[0];

async function seedRun(values: {
  guildId?: string | null;
  channelId?: string | null;
  status?: string;
  dryRun?: boolean;
  triggerReason?: string | null;
  startedAt?: Date;
}): Promise<number> {
  const [row] = await db
    .insert(sleepCycleRuns)
    .values({
      guildId: values.guildId ?? null,
      channelId: values.channelId ?? null,
      status: values.status ?? "succeeded",
      dryRun: values.dryRun ?? false,
      triggerReason: values.triggerReason ?? null,
      startedAt: values.startedAt ?? new Date(),
    })
    .returning({ id: sleepCycleRuns.id });
  if (!row) throw new Error("failed to seed run");
  return row.id;
}

async function seedChange(values: {
  runId: number;
  kind: string;
  targetId?: string | null;
  after?: Record<string, unknown> | null;
  reverted?: boolean;
}): Promise<number> {
  const [row] = await db
    .insert(sleepCycleChanges)
    .values({
      runId: values.runId,
      kind: values.kind,
      targetId: values.targetId ?? null,
      after: values.after ?? null,
      reverted: values.reverted ?? false,
    })
    .returning({ id: sleepCycleChanges.id });
  if (!row) throw new Error("failed to seed change");
  return row.id;
}

// registration

test("registers every subcommand and gates it on Manage Guild", () => {
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(chatInput.length, 1);
  const json = chatInput[0]?.builder.toJSON();
  assert.equal(json?.name, "sleep-cycle");
  assert.equal(
    json?.default_member_permissions,
    String(PermissionFlagsBits.ManageGuild)
  );
  assert.deepEqual(
    json?.options?.map((o) => o.name),
    [
      "enable",
      "disable",
      "status",
      "run-now",
      "changes",
      "rollback",
      "set-dry-run",
      "set-auto-skills",
      "set-report-channel",
    ]
  );
  assert.equal(json?.integration_types?.length, 2);
  assert.equal(json?.contexts?.length, 3);
});

test("adds a guild-scoped registration when GUILD_ID is set", () => {
  env.GUILD_ID = "guild-42";
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(chatInput.length, 2);
  assert.deepEqual(chatInput[0]?.options, { guildIds: ["guild-42"] });
});

// enable / disable

test("enable inserts guild settings in dry-run mode with reports off", async () => {
  const interaction = makeInteraction({
    guildId: "g-enable",
    options: { subcommand: "enable" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(interaction.deferReply.mock.calls.length, 1);
  assert.match(lastReplyText(interaction), /^Sleep cycle enabled in dry-run/);
  const settings = await guildSettings("g-enable");
  assert.equal(settings?.enabled, true);
  assert.equal(settings?.dryRun, true);
  assert.equal(settings?.channelId, null);
  assert.equal(settings?.reportChannelId, null);
});

test("enable in a DM scopes to the channel and reports back into it", async () => {
  const interaction = makeInteraction({
    guildId: null,
    channelId: "dm-enable",
    options: { subcommand: "enable" },
  });

  await command.chatInputRun(interaction as never);

  const settings = await channelSettings("dm-enable");
  assert.equal(settings?.guildId, null);
  assert.equal(settings?.enabled, true);
  assert.equal(settings?.reportChannelId, "dm-enable");
});

test("disable updates the existing row instead of inserting a second one", async () => {
  const enable = makeInteraction({
    guildId: "g-disable",
    options: { subcommand: "enable" },
  });
  await command.chatInputRun(enable as never);

  const disable = makeInteraction({
    guildId: "g-disable",
    options: { subcommand: "disable" },
  });
  await command.chatInputRun(disable as never);

  assert.equal(lastReplyText(disable), "Sleep cycle disabled.");
  const rows = await db
    .select()
    .from(sleepCycleSettings)
    .where(eq(sleepCycleSettings.guildId, "g-disable"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.enabled, false);
});

// status

test("status says a guild is unconfigured and lists nothing", async () => {
  const interaction = makeInteraction({
    guildId: "g-unset",
    options: { subcommand: "status" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    "Sleep cycle is not configured for this guild."
  );
});

test("status says a DM is unconfigured", async () => {
  const interaction = makeInteraction({
    guildId: null,
    channelId: "dm-unset",
    options: { subcommand: "status" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    "Sleep cycle is not configured for this DM."
  );
});

test("status summarises settings and the most recent runs", async () => {
  const enable = makeInteraction({
    guildId: "g-status",
    options: { subcommand: "enable" },
  });
  await command.chatInputRun(enable as never);
  const report = makeInteraction({
    guildId: "g-status",
    options: {
      subcommand: "set-report-channel",
      channels: { channel: { id: "chan-report" } },
    },
  });
  await command.chatInputRun(report as never);

  const started = new Date("2030-05-05T10:00:00.000Z");
  const runId = await seedRun({
    guildId: "g-status",
    status: "succeeded",
    dryRun: true,
    triggerReason: "manual",
    startedAt: started,
  });

  const interaction = makeInteraction({
    guildId: "g-status",
    options: { subcommand: "status" },
  });
  await command.chatInputRun(interaction as never);

  const lines = lastReplyText(interaction).split("\n");
  assert.equal(
    lines[0],
    "**Enabled**: true · **Dry run**: true · **Auto skills**: false · **Reports**: <#chan-report>"
  );
  assert.equal(lines[1], "**Activity gate**: <= 3 msgs in last 60m");
  assert.equal(lines[2], "**Max runs/day**: 2");
  assert.match(
    lines[3] ?? "",
    /^\*\*Last run\*\*: never · \*\*Next eligible\*\*: /
  );
  assert.equal(lines[4], "");
  assert.equal(lines[5], "**Recent runs**:");
  assert.equal(
    lines[6],
    `- #${runId} [succeeded, dry] manual — started ${started.toISOString()}`
  );
});

test("status keeps another scope's runs out and omits an absent trigger", async () => {
  await seedRun({ guildId: "g-elsewhere", triggerReason: "scheduled" });
  const mine = await seedRun({ channelId: "dm-status", status: "failed" });

  const interaction = makeInteraction({
    guildId: null,
    channelId: "dm-status",
    options: { subcommand: "status" },
  });
  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.match(reply, new RegExp(`- #${mine} \\[failed\\] - — started `));
  assert.ok(!reply.includes("scheduled"));
});

// run-now

test("run-now forwards the scope and dry flag, then reports phase stats", async () => {
  dreamPass.mockResolvedValue({
    runId: 7,
    status: "succeeded",
    dryRun: true,
    phaseStats: {
      consolidate_facts: { resolutions: 2, skipped: 1 },
      dedupe_topics: {},
    },
  });
  const interaction = makeInteraction({
    guildId: "g-run",
    options: { subcommand: "run-now", booleans: { dry: true } },
  });

  await command.chatInputRun(interaction as never);

  assert.deepEqual(dreamPass.mock.calls[0]?.[0], {
    guildId: "g-run",
    channelId: null,
    triggerReason: "manual",
    forceDryRun: true,
  });
  assert.equal(
    lastReplyText(interaction),
    [
      "Run #7 succeeded.",
      "",
      "**Phase stats**:",
      "- consolidate_facts: resolutions=2 skipped=1",
      "- dedupe_topics: (no activity)",
    ].join("\n")
  );
});

test("run-now leaves the dry-run override unset when the option is absent", async () => {
  dreamPass.mockResolvedValue({
    runId: 8,
    status: "failed",
    dryRun: false,
    phaseStats: {},
    error: "the model timed out",
  });
  const interaction = makeInteraction({
    guildId: null,
    channelId: "dm-run",
    options: { subcommand: "run-now" },
  });

  await command.chatInputRun(interaction as never);

  assert.deepEqual(dreamPass.mock.calls[0]?.[0], {
    guildId: null,
    channelId: "dm-run",
    triggerReason: "manual",
    forceDryRun: undefined,
  });
  assert.equal(
    lastReplyText(interaction),
    ["Run #8 failed.", "", "Error: the model timed out"].join("\n")
  );
});

// changes

test("changes refuses a run from another scope", async () => {
  const runId = await seedRun({ guildId: "g-other" });
  const interaction = makeInteraction({
    guildId: "g-changes",
    options: { subcommand: "changes", integers: { "run-id": runId } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    `Run #${runId} not found for this scope.`
  );
});

test("changes reports an empty run", async () => {
  const runId = await seedRun({ guildId: "g-changes" });
  const interaction = makeInteraction({
    guildId: "g-changes",
    options: { subcommand: "changes", integers: { "run-id": runId } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    `Run #${runId} had no recorded changes.`
  );
});

test("changes lists newest first, marking reverted rows and payloads", async () => {
  const runId = await seedRun({ guildId: "g-changes-list" });
  const first = await seedChange({
    runId,
    kind: "persona_addendum",
    targetId: "addendum-3",
    after: { text: "be warmer" },
  });
  const second = await seedChange({
    runId,
    kind: "topic_merge",
    reverted: true,
  });
  const interaction = makeInteraction({
    guildId: "g-changes-list",
    options: { subcommand: "changes", integers: { "run-id": runId } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    [
      `Run #${runId} changes:`,
      `↩︎ #${second} [topic_merge]`,
      `• #${first} [persona_addendum] target=addendum-3 → {"text":"be warmer"}`,
    ].join("\n")
  );
});

test("changes truncates a long listing", async () => {
  const runId = await seedRun({ channelId: "dm-changes" });
  for (let i = 0; i < 25; i++) {
    await seedChange({
      runId,
      kind: "fact_resolve",
      targetId: `target-${i}`,
      after: { note: "n".repeat(300) },
    });
  }
  const interaction = makeInteraction({
    guildId: null,
    channelId: "dm-changes",
    options: { subcommand: "changes", integers: { "run-id": runId } },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.equal(reply.length, 1901);
  assert.ok(reply.endsWith("…"));
});

// rollback

test("rollback insists on exactly one of run-id or change-id", async () => {
  const neither = makeInteraction({
    guildId: "g-rb",
    options: { subcommand: "rollback" },
  });
  await command.chatInputRun(neither as never);
  assert.equal(
    lastReplyText(neither),
    "Provide exactly one of `run-id` or `change-id`."
  );

  const both = makeInteraction({
    guildId: "g-rb",
    options: {
      subcommand: "rollback",
      integers: { "run-id": 1, "change-id": 2 },
    },
  });
  await command.chatInputRun(both as never);
  assert.equal(
    lastReplyText(both),
    "Provide exactly one of `run-id` or `change-id`."
  );
  assert.equal(runRollback.mock.calls.length, 0);
  assert.equal(changeRollback.mock.calls.length, 0);
});

test("rollback refuses a run from another scope", async () => {
  const runId = await seedRun({ guildId: "g-rb-other" });
  const interaction = makeInteraction({
    guildId: "g-rb",
    options: { subcommand: "rollback", integers: { "run-id": runId } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    `Run #${runId} not found for this scope.`
  );
  assert.equal(runRollback.mock.calls.length, 0);
});

test("rollback by run id reports the tally", async () => {
  const runId = await seedRun({ guildId: "g-rb-run" });
  runRollback.mockResolvedValue({ reverted: 3, skipped: 1, errors: [] });
  const interaction = makeInteraction({
    guildId: "g-rb-run",
    options: { subcommand: "rollback", integers: { "run-id": runId } },
  });

  await command.chatInputRun(interaction as never);

  assert.deepEqual(runRollback.mock.calls[0], [runId]);
  assert.equal(lastReplyText(interaction), "Reverted 3 · skipped 1");

  runRollback.mockResolvedValue({
    reverted: 0,
    skipped: 4,
    errors: ["target row is gone"],
  });
  const retry = makeInteraction({
    guildId: "g-rb-run",
    options: { subcommand: "rollback", integers: { "run-id": runId } },
  });
  await command.chatInputRun(retry as never);
  assert.equal(
    lastReplyText(retry),
    "Reverted 0 · skipped 4 · errors: target row is gone"
  );
});

test("rollback by change id reports errors alongside the tally", async () => {
  const runId = await seedRun({ guildId: "g-rb-change" });
  const changeId = await seedChange({ runId, kind: "wake_link" });
  changeRollback.mockResolvedValue({
    reverted: 1,
    skipped: 0,
    errors: ["row vanished", "already reverted"],
  });
  const interaction = makeInteraction({
    guildId: "g-rb-change",
    options: { subcommand: "rollback", integers: { "change-id": changeId } },
  });

  await command.chatInputRun(interaction as never);

  assert.deepEqual(changeRollback.mock.calls[0], [changeId]);
  assert.equal(
    lastReplyText(interaction),
    "Reverted 1 · skipped 0 · errors: row vanished; already reverted"
  );

  changeRollback.mockResolvedValue({ reverted: 1, skipped: 0, errors: [] });
  const clean = makeInteraction({
    guildId: "g-rb-change",
    options: { subcommand: "rollback", integers: { "change-id": changeId } },
  });
  await command.chatInputRun(clean as never);
  assert.equal(lastReplyText(clean), "Reverted 1 · skipped 0");
});

test("rollback refuses a change belonging to another scope", async () => {
  const runId = await seedRun({ guildId: "g-rb-elsewhere" });
  const changeId = await seedChange({ runId, kind: "wake_link" });
  const interaction = makeInteraction({
    guildId: "g-rb-here",
    options: { subcommand: "rollback", integers: { "change-id": changeId } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    `Change #${changeId} not found for this scope.`
  );
  assert.equal(changeRollback.mock.calls.length, 0);
});

test("rollback refuses a change id that does not exist", async () => {
  const interaction = makeInteraction({
    guildId: "g-rb-here",
    options: { subcommand: "rollback", integers: { "change-id": 987654 } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    "Change #987654 not found for this scope."
  );
});

// setters

test("set-dry-run flips the stored flag", async () => {
  const enable = makeInteraction({
    guildId: "g-set",
    options: { subcommand: "enable" },
  });
  await command.chatInputRun(enable as never);

  const interaction = makeInteraction({
    guildId: "g-set",
    options: { subcommand: "set-dry-run", booleans: { value: false } },
  });
  await command.chatInputRun(interaction as never);

  assert.equal(lastReplyText(interaction), "Set `dryRun` = `false`.");
  assert.equal((await guildSettings("g-set"))?.dryRun, false);
});

test("set-auto-skills flips the stored flag, creating settings if needed", async () => {
  const interaction = makeInteraction({
    guildId: "g-skills",
    options: { subcommand: "set-auto-skills", booleans: { value: true } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(lastReplyText(interaction), "Set `autoAuthorSkills` = `true`.");
  const settings = await guildSettings("g-skills");
  assert.equal(settings?.autoAuthorSkills, true);
  // creating the row this way leaves the cycle itself off
  assert.equal(settings?.enabled, false);
});

test("set-report-channel stores the chosen channel", async () => {
  const interaction = makeInteraction({
    guildId: "g-report",
    options: {
      subcommand: "set-report-channel",
      channels: { channel: { id: "chan-digest" } },
    },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    "Dream reports will be posted to <#chan-digest> after each scheduled pass."
  );
  assert.equal(
    (await guildSettings("g-report"))?.reportChannelId,
    "chan-digest"
  );
});

test("set-report-channel with no channel turns reports off", async () => {
  const set = makeInteraction({
    guildId: "g-report-off",
    options: {
      subcommand: "set-report-channel",
      channels: { channel: { id: "chan-digest" } },
    },
  });
  await command.chatInputRun(set as never);

  const clear = makeInteraction({
    guildId: "g-report-off",
    options: { subcommand: "set-report-channel" },
  });
  await command.chatInputRun(clear as never);

  assert.equal(lastReplyText(clear), "Dream reports disabled.");
  assert.equal((await guildSettings("g-report-off"))?.reportChannelId, null);
});

test("an unknown subcommand still defers but replies nothing", async () => {
  const interaction = makeInteraction({
    guildId: "g-unknown",
    options: { subcommand: "teleport" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(interaction.deferReply.mock.calls.length, 1);
  assert.equal(interaction.editReply.mock.calls.length, 0);
});
