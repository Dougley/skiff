import assert from "node:assert/strict";
import type { Client } from "discord.js";
import { afterEach, beforeEach, type Mock, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

// The scheduler is the unit under test; the pass itself is stubbed so ticks
// stay synchronous, offline and observable.
vi.mock("../../../src/autonomous/sleep/run.js", () => ({
  executeDreamPass: vi.fn(),
}));

const { runMigrations } = await import("../../../src/db/migrate.js");
await runMigrations();
const { startSleepCycle, stopSleepCycle } = await import(
  "../../../src/autonomous/sleep/index.js"
);
const { executeDreamPass } = await import(
  "../../../src/autonomous/sleep/run.js"
);
const { db, conversations, messages, sleepCycleSettings } = await import(
  "../../../src/db/index.js"
);
const { logger } = await import("../../../src/config/logger.js");
const { and, eq, isNull } = await import("drizzle-orm");

type RunResult = import("../../../src/autonomous/sleep/run.js").RunResult;
const dreamPass = executeDreamPass as unknown as Mock;

const okResult = (over: Partial<RunResult> = {}): RunResult => ({
  runId: 1,
  status: "succeeded",
  dryRun: false,
  phaseStats: {},
  ...over,
});

const sent: string[] = [];
const sendMock = vi.fn(async (content: string) => {
  sent.push(content);
  return {};
});
let channelResult: unknown = { isSendable: () => true, send: sendMock };
let channelError: Error | null = null;
const fetchMock = vi.fn(async () => {
  if (channelError) throw channelError;
  return channelResult;
});
const client = { channels: { fetch: fetchMock } } as unknown as Client;

const PAST = () => new Date(Date.now() - 60_000);
const FUTURE = () => new Date(Date.now() + 60 * 60_000);

beforeEach(() => {
  dreamPass.mockReset();
  dreamPass.mockResolvedValue(okResult());
  fetchMock.mockClear();
  sendMock.mockClear();
  sent.length = 0;
  channelResult = { isSendable: () => true, send: sendMock };
  channelError = null;
});

afterEach(() => {
  stopSleepCycle();
});

/** Yield long enough for an in-flight tick's queries to drain. */
async function settle(): Promise<void> {
  for (let round = 0; round < 8; round++) {
    for (let i = 0; i < 6; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    // PGlite serializes queries, so a round trip of our own drains the ones
    // the tick already issued.
    await db.select().from(sleepCycleSettings).limit(1);
  }
}

/** Fire exactly one tick and wait for it to finish. */
async function tickOnce(): Promise<void> {
  startSleepCycle(client);
  await settle();
  stopSleepCycle();
}

async function seedScope(fields: {
  guildId?: string | null;
  channelId?: string | null;
  enabled?: boolean;
  eligible?: boolean;
  reportChannelId?: string | null;
  lowActivityMinutes?: number;
  minInactiveMessages?: number;
  maxRunsPerDay?: number;
}): Promise<void> {
  await db.insert(sleepCycleSettings).values({
    guildId: fields.guildId ?? null,
    channelId: fields.channelId ?? null,
    enabled: fields.enabled ?? true,
    dryRun: false,
    reportChannelId: fields.reportChannelId ?? null,
    lowActivityMinutes: fields.lowActivityMinutes ?? 60,
    minInactiveMessages: fields.minInactiveMessages ?? 0,
    maxRunsPerDay: fields.maxRunsPerDay ?? 2,
    nextEligibleAt: (fields.eligible ?? true) ? PAST() : FUTURE(),
  });
}

async function scopeRow(scope: { guildId?: string; channelId?: string }) {
  const [row] = await db
    .select()
    .from(sleepCycleSettings)
    .where(
      scope.guildId
        ? eq(sleepCycleSettings.guildId, scope.guildId)
        : eq(sleepCycleSettings.channelId, scope.channelId as string)
    );
  assert.ok(row);
  return row;
}

async function arm(scope: {
  guildId?: string;
  channelId?: string;
}): Promise<void> {
  await db
    .update(sleepCycleSettings)
    .set({ nextEligibleAt: PAST() })
    .where(
      scope.guildId
        ? eq(sleepCycleSettings.guildId, scope.guildId)
        : eq(sleepCycleSettings.channelId, scope.channelId as string)
    );
}

/** Park every configured scope so a tick finds nothing eligible. */
async function parkAll(): Promise<void> {
  await db.update(sleepCycleSettings).set({ nextEligibleAt: FUTURE() });
}

async function seedActivity(
  scope: { guildId?: string | null; channelId: string },
  count: number
): Promise<void> {
  const [conversation] = await db
    .insert(conversations)
    .values({
      channelId: scope.channelId,
      guildId: scope.guildId ?? null,
      model: "test-model",
    })
    .returning();
  assert.ok(conversation);
  for (let i = 0; i < count; i++) {
    await db.insert(messages).values({
      conversationId: conversation.id,
      role: "user",
      content: `chatter ${i}`,
    });
  }
}

async function waitForPass(calls = 1): Promise<void> {
  await vi.waitFor(() => {
    assert.equal(dreamPass.mock.calls.length, calls);
  });
}

test("a quiet, eligible guild scope gets a scheduled dream pass", async () => {
  await parkAll();
  await seedScope({ guildId: "idx-g1", maxRunsPerDay: 2 });

  startSleepCycle(client);
  await waitForPass();
  await settle();
  stopSleepCycle();

  assert.deepEqual(dreamPass.mock.calls[0]?.[0], {
    guildId: "idx-g1",
    channelId: null,
    triggerReason: "scheduled",
  });
  // no report channel configured → nothing is posted
  assert.equal(fetchMock.mock.calls.length, 0);

  const row = await scopeRow({ guildId: "idx-g1" });
  assert.ok(row.lastRunAt);
  // 2 runs/day → next window is 12h out
  const gapHours = (row.nextEligibleAt.getTime() - Date.now()) / 3_600_000;
  assert.ok(gapHours > 11 && gapHours < 13, `gap was ${gapHours}h`);
});

test("the cooldown never drops below an hour, however many runs are allowed", async () => {
  await parkAll();
  await seedScope({ guildId: "idx-g2", maxRunsPerDay: 96 });

  startSleepCycle(client);
  await waitForPass();
  await settle();
  stopSleepCycle();

  const row = await scopeRow({ guildId: "idx-g2" });
  // 24h/96 = 15min, floored to the 1h minimum
  const gapMinutes = (row.nextEligibleAt.getTime() - Date.now()) / 60_000;
  assert.ok(gapMinutes > 55 && gapMinutes < 65, `gap was ${gapMinutes}min`);
});

test("scopes with recent chatter are deferred, not dreamed on", async () => {
  await parkAll();
  await seedScope({ guildId: "idx-busy", minInactiveMessages: 2 });
  await seedActivity({ guildId: "idx-busy", channelId: "idx-busy-chan" }, 3);
  await seedScope({ guildId: "idx-calm" });

  startSleepCycle(client);
  await waitForPass();
  await settle();
  stopSleepCycle();

  // only the calm scope ran
  assert.equal(dreamPass.mock.calls.length, 1);
  assert.equal(dreamPass.mock.calls[0]?.[0]?.guildId, "idx-calm");

  const busy = await scopeRow({ guildId: "idx-busy" });
  assert.equal(busy.lastRunAt, null);
  // deferred scopes are not claimed either, so they stay eligible
  assert.ok(busy.nextEligibleAt.getTime() < Date.now());
});

test("a guild just under its activity threshold still dreams", async () => {
  await parkAll();
  await seedScope({ guildId: "idx-quietish", minInactiveMessages: 3 });
  await seedActivity(
    { guildId: "idx-quietish", channelId: "idx-quietish-chan" },
    3
  );

  startSleepCycle(client);
  await waitForPass();
  await settle();
  stopSleepCycle();

  assert.equal(dreamPass.mock.calls[0]?.[0]?.guildId, "idx-quietish");
});

test("messages older than the activity window do not block a pass", async () => {
  await parkAll();
  await seedScope({
    guildId: "idx-stale",
    lowActivityMinutes: 30,
    minInactiveMessages: 0,
  });
  const [conversation] = await db
    .insert(conversations)
    .values({
      channelId: "idx-stale-chan",
      guildId: "idx-stale",
      model: "test-model",
    })
    .returning();
  assert.ok(conversation);
  await db.insert(messages).values({
    conversationId: conversation.id,
    role: "user",
    content: "ancient history",
    createdAt: new Date(Date.now() - 2 * 60 * 60_000),
  });

  startSleepCycle(client);
  await waitForPass();
  await settle();
  stopSleepCycle();

  assert.equal(dreamPass.mock.calls[0]?.[0]?.guildId, "idx-stale");
});

test("DM scopes are keyed by channel and gated on that channel's traffic", async () => {
  await parkAll();
  await seedScope({ channelId: "idx-dm-busy", minInactiveMessages: 0 });
  await seedActivity({ channelId: "idx-dm-busy" }, 1);
  await seedScope({ channelId: "idx-dm-calm" });

  startSleepCycle(client);
  await waitForPass();
  await settle();
  stopSleepCycle();

  assert.equal(dreamPass.mock.calls.length, 1);
  assert.deepEqual(dreamPass.mock.calls[0]?.[0], {
    guildId: null,
    channelId: "idx-dm-calm",
    triggerReason: "scheduled",
  });
  assert.equal((await scopeRow({ channelId: "idx-dm-busy" })).lastRunAt, null);
});

test("disabled scopes and scopes still in cooldown are left alone", async () => {
  await parkAll();
  await seedScope({ guildId: "idx-off", enabled: false });
  await seedScope({ guildId: "idx-cooling", eligible: false });
  await seedScope({ guildId: "idx-ready" });

  startSleepCycle(client);
  await waitForPass();
  await settle();
  stopSleepCycle();

  assert.equal(dreamPass.mock.calls.length, 1);
  assert.equal(dreamPass.mock.calls[0]?.[0]?.guildId, "idx-ready");
});

test("a row scoped to neither a guild nor a channel is ignored", async () => {
  await parkAll();
  await seedScope({ guildId: null, channelId: null });
  await seedScope({ guildId: "idx-wellformed" });

  startSleepCycle(client);
  await waitForPass();
  await settle();
  stopSleepCycle();

  assert.equal(dreamPass.mock.calls.length, 1);
  assert.equal(dreamPass.mock.calls[0]?.[0]?.guildId, "idx-wellformed");

  // drop it again so later ticks see a clean settings table
  await db
    .delete(sleepCycleSettings)
    .where(
      and(
        isNull(sleepCycleSettings.guildId),
        isNull(sleepCycleSettings.channelId)
      )
    );
});

test("a tick with nothing eligible is a no-op", async () => {
  await parkAll();

  await tickOnce();

  assert.equal(dreamPass.mock.calls.length, 0);
});

test("a tick where every eligible scope is busy claims nothing", async () => {
  await parkAll();
  await seedScope({ guildId: "idx-allbusy", minInactiveMessages: 0 });
  await seedActivity(
    { guildId: "idx-allbusy", channelId: "idx-allbusy-chan" },
    2
  );

  await tickOnce();

  assert.equal(dreamPass.mock.calls.length, 0);
  const row = await scopeRow({ guildId: "idx-allbusy" });
  assert.equal(row.lastRunAt, null);
  assert.ok(row.nextEligibleAt.getTime() < Date.now());
});

test("losing the claim on one scope does not block the others", async () => {
  await parkAll();
  await seedScope({ guildId: "idx-lost" });
  await seedScope({ guildId: "idx-won" });

  // the first claim update matches nothing, as if another worker got there
  const realUpdate = db.update;
  let updates = 0;
  (db as { update: unknown }).update = (...args: unknown[]) => {
    updates++;
    if (updates === 1) {
      return { set: () => ({ where: () => ({ returning: async () => [] }) }) };
    }
    return (realUpdate as (...a: unknown[]) => unknown).apply(db, args);
  };
  try {
    startSleepCycle(client);
    await waitForPass();
    await settle();
    stopSleepCycle();
  } finally {
    (db as { update: unknown }).update = realUpdate;
  }

  assert.equal(dreamPass.mock.calls.length, 1);
  assert.equal(dreamPass.mock.calls[0]?.[0]?.guildId, "idx-won");
  // the scope we lost was never rescheduled either
  assert.equal((await scopeRow({ guildId: "idx-lost" })).lastRunAt, null);
});

test("a scope claimed by another worker is not run twice", async () => {
  await parkAll();
  await seedScope({ guildId: "idx-raced" });

  // simulate losing the claim race: the conditional update matches no rows
  const realUpdate = db.update;
  (db as { update: unknown }).update = () => ({
    set: () => ({ where: () => ({ returning: async () => [] }) }),
  });
  try {
    await tickOnce();
  } finally {
    (db as { update: unknown }).update = realUpdate;
  }
  assert.equal(dreamPass.mock.calls.length, 0);

  // the row was never touched, so the next tick still picks it up
  startSleepCycle(client);
  await waitForPass();
  await settle();
  stopSleepCycle();
  assert.equal(dreamPass.mock.calls[0]?.[0]?.guildId, "idx-raced");
});

test("claiming a scope leases it, so an immediate re-tick skips it", async () => {
  await parkAll();
  await seedScope({ guildId: "idx-lease" });
  dreamPass.mockImplementation(async () => {
    // while the pass is running the row is already leased out
    const row = await scopeRow({ guildId: "idx-lease" });
    assert.ok(row.nextEligibleAt.getTime() > Date.now());
    return okResult();
  });

  startSleepCycle(client);
  await waitForPass();
  await settle();
  stopSleepCycle();

  await tickOnce();
  assert.equal(dreamPass.mock.calls.length, 1);
});

test("an eventful pass is summarized to the report channel", async () => {
  await parkAll();
  await seedScope({ guildId: "idx-report", reportChannelId: "chan-1" });
  dreamPass.mockResolvedValue(
    okResult({
      runId: 77,
      phaseStats: {
        consolidate_facts: { resolutions: 2 },
        dedupe_topics: { merges: 1 },
        synthesize_topics: { topicsCreated: 3 },
        reflect_persona: { addendaWritten: 1 },
        propose_skills: { skillsAuthored: 2 },
      },
    })
  );

  startSleepCycle(client);
  await vi.waitFor(() => assert.equal(sent.length, 1));
  await settle();
  stopSleepCycle();

  assert.equal(fetchMock.mock.calls.length, 1);
  const report = sent[0] ?? "";
  assert.equal(
    report.split("\n")[0],
    "🌙 Dream pass #77: resolved 2 fact conflicts, merged 1 duplicate topic, learned 3 new topics, wrote 1 persona note, 2 skill proposals."
  );
  assert.match(report, /\/sleep-cycle changes run-id:77/);
  assert.match(report, /\/sleep-cycle rollback run-id:77/);
});

test("a dry run says so and offers no rollback", async () => {
  await parkAll();
  await arm({ guildId: "idx-report" });
  dreamPass.mockResolvedValue(
    okResult({
      runId: 78,
      dryRun: true,
      phaseStats: {
        consolidate_facts: { resolutions: 1 },
        reflect_persona: { addendaLogged: 2 },
        propose_skills: { proposalsPending: 1 },
      },
    })
  );

  startSleepCycle(client);
  await vi.waitFor(() => assert.equal(sent.length, 1));
  await settle();
  stopSleepCycle();

  const report = sent[0] ?? "";
  assert.equal(
    report.split("\n")[0],
    "🌙 Dream pass #78 (dry run — nothing applied): resolved 1 fact conflict, wrote 2 persona notes, 1 skill proposal."
  );
  assert.match(report, /\/sleep-cycle changes run-id:78/);
  assert.doesNotMatch(report, /rollback/);
});

test("a quiet night produces no report at all", async () => {
  await parkAll();
  await arm({ guildId: "idx-report" });
  dreamPass.mockResolvedValue(okResult({ runId: 79, phaseStats: {} }));

  await tickOnce();

  assert.equal(dreamPass.mock.calls.length, 1);
  assert.equal(fetchMock.mock.calls.length, 0);
  assert.equal(sent.length, 0);
});

test("a failed pass is reported with its error", async () => {
  await parkAll();
  await arm({ guildId: "idx-report" });
  dreamPass.mockResolvedValue({
    runId: 80,
    status: "failed",
    dryRun: false,
    phaseStats: {},
    error: "the model hung up",
  } satisfies RunResult);

  startSleepCycle(client);
  await vi.waitFor(() => assert.equal(sent.length, 1));
  await settle();
  stopSleepCycle();

  assert.equal(sent[0], "🌙 Dream pass #80 failed: the model hung up");
});

test("a failure with no message still reports something", async () => {
  await parkAll();
  await arm({ guildId: "idx-report" });
  dreamPass.mockResolvedValue({
    runId: 81,
    status: "failed",
    dryRun: false,
    phaseStats: {},
  } satisfies RunResult);

  startSleepCycle(client);
  await vi.waitFor(() => assert.equal(sent.length, 1));
  await settle();
  stopSleepCycle();

  assert.equal(sent[0], "🌙 Dream pass #81 failed: unknown error");
});

test("an unsendable report channel is warned about, not crashed on", async () => {
  await parkAll();
  await arm({ guildId: "idx-report" });
  dreamPass.mockResolvedValue(
    okResult({ runId: 82, phaseStats: { dedupe_topics: { merges: 1 } } })
  );
  channelResult = { isSendable: () => false, send: sendMock };

  const warnings: string[] = [];
  const realWarn = logger.warn;
  logger.warn = ((message: unknown) => {
    warnings.push(String(message));
  }) as typeof logger.warn;
  try {
    await tickOnce();
  } finally {
    logger.warn = realWarn;
  }

  assert.equal(sendMock.mock.calls.length, 0);
  assert.ok(warnings.some((w) => w.includes("report channel not sendable")));
  // the scope is still rescheduled despite the report failing
  assert.ok((await scopeRow({ guildId: "idx-report" })).lastRunAt);
});

test("a missing report channel is treated as unsendable", async () => {
  await parkAll();
  await arm({ guildId: "idx-report" });
  dreamPass.mockResolvedValue(
    okResult({ runId: 83, phaseStats: { dedupe_topics: { merges: 1 } } })
  );
  channelResult = null;

  await tickOnce();

  assert.equal(sendMock.mock.calls.length, 0);
});

test("a report channel that blows up does not derail the tick", async () => {
  await parkAll();
  await arm({ guildId: "idx-report" });
  dreamPass.mockResolvedValue(
    okResult({
      runId: 84,
      phaseStats: { synthesize_topics: { topicsCreated: 1 } },
    })
  );
  channelError = new Error("missing access");

  const warnings: string[] = [];
  const realWarn = logger.warn;
  logger.warn = ((message: unknown) => {
    warnings.push(String(message));
  }) as typeof logger.warn;
  try {
    await tickOnce();
  } finally {
    logger.warn = realWarn;
  }

  assert.ok(warnings.some((w) => w.includes("failed to send dream report")));
  assert.ok((await scopeRow({ guildId: "idx-report" })).lastRunAt);
});

test("a pass that throws is logged and the scope is still rescheduled", async () => {
  await parkAll();
  await seedScope({ guildId: "idx-throws", reportChannelId: "chan-1" });
  dreamPass.mockRejectedValue(new Error("pass exploded"));

  const warnings: string[] = [];
  const realWarn = logger.warn;
  logger.warn = ((message: unknown) => {
    warnings.push(String(message));
  }) as typeof logger.warn;
  try {
    await tickOnce();
  } finally {
    logger.warn = realWarn;
  }

  assert.ok(warnings.some((w) => w.includes("dream pass threw")));
  assert.equal(sendMock.mock.calls.length, 0);
  const row = await scopeRow({ guildId: "idx-throws" });
  assert.ok(row.lastRunAt);
  assert.ok(row.nextEligibleAt.getTime() > Date.now());
});

test("a tick that blows up entirely is logged and does not reject", async () => {
  const errors: string[] = [];
  const realError = logger.error;
  const realSelect = db.select;
  logger.error = ((message: unknown) => {
    errors.push(String(message));
  }) as typeof logger.error;
  (db as { select: unknown }).select = () => {
    throw new Error("db down");
  };
  try {
    startSleepCycle(client);
    stopSleepCycle();
  } finally {
    (db as { select: unknown }).select = realSelect;
    logger.error = realError;
  }
  await settle();

  assert.ok(errors.some((e) => e.includes("tick failed")));

  // the ticking guard was released, so the scheduler still works afterwards
  await parkAll();
  await seedScope({ guildId: "idx-recovered" });
  startSleepCycle(client);
  await waitForPass();
  await settle();
  stopSleepCycle();
  assert.equal(dreamPass.mock.calls[0]?.[0]?.guildId, "idx-recovered");
});

test("the scheduler starts once, re-ticks on its interval, and stops", async () => {
  await parkAll();
  await seedScope({ guildId: "idx-interval" });
  // only the interval is faked; PGlite keeps its real timers
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const debugs: string[] = [];
  const realDebug = logger.debug;
  logger.debug = ((message: unknown) => {
    debugs.push(String(message));
  }) as typeof logger.debug;

  try {
    startSleepCycle(client);
    assert.equal(vi.getTimerCount(), 1);
    // a second start must not stack another interval
    startSleepCycle(client);
    assert.equal(vi.getTimerCount(), 1);

    // the first tick is still awaiting the database here, so an interval
    // firing now is skipped rather than running concurrently
    vi.advanceTimersByTime(5 * 60 * 1000);
    assert.ok(debugs.some((d) => d.includes("previous tick still running")));

    // vi.waitFor would drive the faked interval, so settle by hand here
    await settle();
    assert.equal(dreamPass.mock.calls.length, 1);

    // once idle, the next interval fires a fresh tick
    await arm({ guildId: "idx-interval" });
    vi.advanceTimersByTime(5 * 60 * 1000);
    await settle();
    assert.equal(dreamPass.mock.calls.length, 2);

    stopSleepCycle();
    assert.equal(vi.getTimerCount(), 0);
    // stopping twice is harmless
    stopSleepCycle();
    assert.equal(vi.getTimerCount(), 0);
  } finally {
    logger.debug = realDebug;
    vi.useRealTimers();
  }
});
