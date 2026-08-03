import assert from "node:assert/strict";
import type { Client } from "discord.js";
import { afterEach, beforeAll, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

const turn = vi.hoisted(() => ({ handleConversationTurn: vi.fn() }));
vi.mock("../../../src/ai/llm/conversation-turn.js", () => turn);

bootstrapTestEnv();

const CLAIM_SENTINEL = new Date("9999-01-01T00:00:00Z");

let scheduler: typeof import("../../../src/autonomous/scheduler/index.js");
let db: typeof import("../../../src/db/index.js").db;
let scheduledTasks: typeof import("../../../src/db/index.js").scheduledTasks;
let eq: typeof import("drizzle-orm").eq;

beforeAll(async () => {
  const { runMigrations } = await import("../../../src/db/migrate.js");
  await runMigrations();
  scheduler = await import("../../../src/autonomous/scheduler/index.js");
  ({ db, scheduledTasks } = await import("../../../src/db/index.js"));
  ({ eq } = await import("drizzle-orm"));
});

afterEach(async () => {
  scheduler.stopScheduler();
  vi.useRealTimers();
  vi.restoreAllMocks();
  turn.handleConversationTurn.mockReset();
  await db.delete(scheduledTasks);
});

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  what: string,
  timeoutMs = 3000
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Let any in-flight tick work settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

function turnResult(text: string) {
  return {
    messages: [{ components: [{ type: 10, content: text }], files: [] }],
    text,
    usedTools: false,
    historyLength: 1,
  };
}

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    name: "general",
    guild: { name: "Test Guild" },
    isSendable: () => true,
    isDMBased: () => false,
    send: vi.fn(async (_payload?: unknown) => undefined),
    ...overrides,
  };
}

function makeClient(
  fetchImpl: (id: string) => Promise<unknown>
): Client & { channels: { fetch: ReturnType<typeof vi.fn> } } {
  return {
    user: { id: "bot-id" },
    channels: { fetch: vi.fn(fetchImpl) },
  } as unknown as Client & { channels: { fetch: ReturnType<typeof vi.fn> } };
}

type TaskOverrides = Partial<typeof scheduledTasks.$inferInsert>;

async function insertTask(overrides: TaskOverrides = {}) {
  const [task] = await db
    .insert(scheduledTasks)
    .values({
      guildId: "guild-1",
      channelId: "chan-1",
      createdByUserId: "user-1",
      name: "Test task",
      instruction: "Do the thing",
      nextRunAt: new Date(Date.now() - 1000),
      ...overrides,
    })
    .returning();
  assert.ok(task);
  return task;
}

async function getTask(id: number) {
  const [task] = await db
    .select()
    .from(scheduledTasks)
    .where(eq(scheduledTasks.id, id));
  assert.ok(task);
  return task;
}

test("a due one-shot reminder fires once and is disabled", async () => {
  const task = await insertTask({ name: "Water the plants" });
  const channel = makeChannel();
  const client = makeClient(async () => channel);
  turn.handleConversationTurn.mockResolvedValue(turnResult("Done!"));

  scheduler.startScheduler(client);
  await waitFor(
    async () => (await getTask(task.id)).enabled === false,
    "the one-shot to be disabled"
  );

  assert.equal(turn.handleConversationTurn.mock.calls.length, 1);
  const params = turn.handleConversationTurn.mock.calls[0]?.[0];
  assert.equal(params.content, "[Reminder: Water the plants]\n\nDo the thing");
  assert.equal(params.userId, "bot-id");
  assert.equal(params.channelId, "chan-1");
  assert.equal(params.guildId, "guild-1");
  assert.equal(params.skipMemory, true);
  assert.equal(params.skipInitialStatus, true);
  assert.equal(params.messageContext.channelName, "#general");
  assert.equal(params.messageContext.guildName, "Test Guild");

  assert.equal(channel.send.mock.calls.length, 1);
  const sent = channel.send.mock.calls[0]?.[0] as { components?: unknown };
  assert.deepEqual(sent.components, [{ type: 10, content: "Done!" }]);

  const after = await getTask(task.id);
  assert.ok(after.lastRunAt);
});

test("a recurring task reschedules anchored to its original slot, not to now", async () => {
  // scheduled slot months in the past — the next run must be anchored to it
  const original = new Date("2026-01-01T12:00:00Z");
  const task = await insertTask({
    name: "Daily report",
    cronExpression: "0 12 * * *",
    timezone: "UTC",
    nextRunAt: original,
  });
  const channel = makeChannel();
  const client = makeClient(async () => channel);
  turn.handleConversationTurn.mockResolvedValue(turnResult("Report ready"));

  scheduler.startScheduler(client);
  await waitFor(
    async () =>
      (await getTask(task.id)).nextRunAt.getTime() !== original.getTime(),
    "the task to reschedule"
  );
  scheduler.stopScheduler();

  const params = turn.handleConversationTurn.mock.calls[0]?.[0];
  assert.equal(
    params.content,
    "[Scheduled Task: Daily report]\n\nDo the thing"
  );

  const after = await getTask(task.id);
  assert.equal(after.enabled, true);
  assert.deepEqual(after.nextRunAt, new Date("2026-01-02T12:00:00Z"));
  assert.ok(after.lastRunAt);
});

test("a recurring task whose cron can never match again is disabled", async () => {
  const task = await insertTask({
    name: "Impossible",
    cronExpression: "0 0 30 2 *", // February 30th never comes
  });
  const channel = makeChannel();
  const client = makeClient(async () => channel);
  turn.handleConversationTurn.mockResolvedValue(turnResult("ran"));

  scheduler.startScheduler(client);
  await waitFor(
    async () => (await getTask(task.id)).enabled === false,
    "the task to be disabled"
  );

  const after = await getTask(task.id);
  assert.ok(after.lastRunAt);
});

test("a DM task is labelled 'DM' with no guild and falls back to a system user", async () => {
  const task = await insertTask({ guildId: null, channelId: "dm-1" });
  // a DM channel carries neither a `name` nor a `guild` property
  const channel = {
    isSendable: () => true,
    isDMBased: () => true,
    send: vi.fn(async (_payload?: unknown) => undefined),
  };
  const client = {
    user: undefined, // no cached bot user yet
    channels: { fetch: vi.fn(async () => channel) },
  } as unknown as Client;
  turn.handleConversationTurn.mockResolvedValue(turnResult("Done!"));

  scheduler.startScheduler(client);
  await waitFor(
    async () => (await getTask(task.id)).enabled === false,
    "the DM task to fire"
  );

  const params = turn.handleConversationTurn.mock.calls[0]?.[0];
  assert.equal(params.userId, "system");
  assert.equal(params.guildId, null);
  assert.equal(params.messageContext.channelName, "DM");
  assert.equal(params.messageContext.guildName, null);
  assert.equal(params.messageContext.isDM, true);
});

test("a guild task whose channel has no resolved guild reports a null guild name", async () => {
  const task = await insertTask();
  const channel = makeChannel({ guild: null });
  const client = makeClient(async () => channel);
  turn.handleConversationTurn.mockResolvedValue(turnResult("Done!"));

  scheduler.startScheduler(client);
  await waitFor(
    async () => (await getTask(task.id)).enabled === false,
    "the task to fire"
  );

  const params = turn.handleConversationTurn.mock.calls[0]?.[0];
  assert.equal(params.messageContext.guildName, null);
});

test("a task that is not yet due is left alone", async () => {
  const future = new Date(Date.now() + 60 * 60 * 1000);
  const task = await insertTask({ nextRunAt: future });
  const client = makeClient(async () => makeChannel());

  scheduler.startScheduler(client);
  await flush();

  assert.equal(turn.handleConversationTurn.mock.calls.length, 0);
  const after = await getTask(task.id);
  assert.equal(after.enabled, true);
  assert.deepEqual(after.nextRunAt, future);
});

test("an unsendable channel skips the turn but still retires the task", async () => {
  const task = await insertTask();
  const channel = makeChannel({ isSendable: () => false });
  const client = makeClient(async () => channel);

  scheduler.startScheduler(client);
  await waitFor(
    async () => (await getTask(task.id)).enabled === false,
    "the task to be retired"
  );

  assert.equal(turn.handleConversationTurn.mock.calls.length, 0);
  assert.equal(channel.send.mock.calls.length, 0);
});

test("a failing LLM turn still retires the task instead of retrying forever", async () => {
  const task = await insertTask();
  const channel = makeChannel();
  const client = makeClient(async () => channel);
  turn.handleConversationTurn.mockRejectedValue(new Error("model exploded"));

  scheduler.startScheduler(client);
  await waitFor(
    async () => (await getTask(task.id)).enabled === false,
    "the task to be retired"
  );

  assert.equal(channel.send.mock.calls.length, 0);
});

test("tasks stuck at the claim sentinel are reclaimed and fired on startup", async () => {
  const task = await insertTask({
    name: "Crashed mid-claim",
    nextRunAt: CLAIM_SENTINEL,
  });
  const channel = makeChannel();
  const client = makeClient(async () => channel);
  turn.handleConversationTurn.mockResolvedValue(turnResult("recovered"));

  scheduler.startScheduler(client);
  await waitFor(
    async () => (await getTask(task.id)).enabled === false,
    "the reclaimed task to fire"
  );

  assert.equal(turn.handleConversationTurn.mock.calls.length, 1);
  const after = await getTask(task.id);
  assert.ok(after.lastRunAt, "the reclaimed task recorded its run");
});

test("a failing reclaim query does not stop the catch-up tick", async () => {
  const task = await insertTask({ name: "Still due" });
  const channel = makeChannel();
  const client = makeClient(async () => channel);
  turn.handleConversationTurn.mockResolvedValue(turnResult("ran anyway"));
  // only the reclaim UPDATE fails; the post-fire UPDATE must still go through
  const update = vi.spyOn(db, "update").mockImplementationOnce(() => {
    throw new Error("db unavailable");
  });

  scheduler.startScheduler(client);
  await waitFor(
    async () => (await getTask(task.id)).enabled === false,
    "the task to fire despite the reclaim failure"
  );

  assert.equal(turn.handleConversationTurn.mock.calls.length, 1);
  assert.ok(update.mock.calls.length > 1);
});

test("a failing due-task query is swallowed and the next tick recovers", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const task = await insertTask({ name: "Deferred" });
  const channel = makeChannel();
  const client = makeClient(async () => channel);
  turn.handleConversationTurn.mockResolvedValue(turnResult("late but done"));
  const select = vi.spyOn(db, "select").mockImplementationOnce(() => {
    throw new Error("db unavailable");
  });

  scheduler.startScheduler(client);
  await waitFor(() => select.mock.calls.length > 0, "the failing select");
  await flush();

  // the tick swallowed the error — nothing ran, nothing was claimed
  assert.equal(turn.handleConversationTurn.mock.calls.length, 0);
  assert.equal((await getTask(task.id)).enabled, true);

  // the interval is still alive and picks the task up on the next pass
  vi.advanceTimersByTime(30_000);
  await waitFor(
    async () => (await getTask(task.id)).enabled === false,
    "the recovering tick"
  );
  assert.equal(turn.handleConversationTurn.mock.calls.length, 1);
});

test("a second start is a no-op and the interval keeps ticking until stopped", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const channel = makeChannel();
  const client = makeClient(async () => channel);
  turn.handleConversationTurn.mockResolvedValue(turnResult("ok"));

  const first = await insertTask({ name: "First" });
  scheduler.startScheduler(client);
  await waitFor(
    async () => (await getTask(first.id)).enabled === false,
    "the immediate tick"
  );
  assert.equal(turn.handleConversationTurn.mock.calls.length, 1);

  // a second start must not run another immediate catch-up tick
  const second = await insertTask({ name: "Second" });
  scheduler.startScheduler(client);
  await flush();
  assert.equal(turn.handleConversationTurn.mock.calls.length, 1);

  // the 30s interval picks the new task up
  vi.advanceTimersByTime(30_000);
  await waitFor(
    async () => (await getTask(second.id)).enabled === false,
    "the interval tick"
  );
  assert.equal(turn.handleConversationTurn.mock.calls.length, 2);

  // after stopping, due tasks stay untouched
  scheduler.stopScheduler();
  const third = await insertTask({ name: "Third" });
  vi.advanceTimersByTime(120_000);
  await flush();
  assert.equal(turn.handleConversationTurn.mock.calls.length, 2);
  assert.equal((await getTask(third.id)).enabled, true);
});
