import assert from "node:assert/strict";
import type { Client } from "discord.js";
import { beforeAll, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const toolOpts = { toolCallId: "test-call", messages: [] } as never;

let createSchedulerTools: typeof import("../../../src/ai/tools/scheduler.js").createSchedulerTools;

beforeAll(async () => {
  const [{ runMigrations }, tools] = await Promise.all([
    import("../../../src/db/migrate.js"),
    import("../../../src/ai/tools/scheduler.js"),
  ]);
  await runMigrations();
  createSchedulerTools = tools.createSchedulerTools;
});

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    client: {} as Client,
    guildId: "sched-guild",
    channelId: "sched-channel",
    userId: "sched-user",
    ...overrides,
  } as import("../../../src/ai/tools/discord.js").DiscordToolContext;
}

/** A fixed point far enough ahead that the "in the past" guard can't fire. */
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

function scheduleInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "task",
    instruction: "do the thing",
    runAt: null,
    cronExpression: null,
    timezone: "UTC",
    ...overrides,
  } as never;
}

test("schedule_task stores a one-shot reminder at the requested time", async () => {
  const tools = createSchedulerTools(ctx({ channelId: "sched-oneshot" }));
  const result = (await tools.schedule_task.execute?.(
    scheduleInput({
      name: "standup",
      instruction: "ping the team",
      runAt: FUTURE,
    }),
    toolOpts
  )) as {
    id: number;
    name: string;
    nextRunAt: string;
    recurring: boolean;
    instruction: string;
  };

  assert.equal(result.name, "standup");
  assert.equal(result.instruction, "ping the team");
  assert.equal(result.recurring, false);
  assert.equal(new Date(result.nextRunAt).toISOString(), FUTURE);
  assert.equal(typeof result.id, "number");
});

test("schedule_task computes the next fire time for a cron expression", async () => {
  const tools = createSchedulerTools(ctx({ channelId: "sched-cron" }));
  const before = Date.now();
  const result = (await tools.schedule_task.execute?.(
    scheduleInput({
      name: "nightly",
      instruction: "summarize the day",
      cronExpression: "0 3 * * *",
      timezone: "Europe/Amsterdam",
    }),
    toolOpts
  )) as { recurring: boolean; nextRunAt: string };

  assert.equal(result.recurring, true);
  // the next 03:00 Amsterdam is strictly ahead and within 24h + DST slack
  const next = new Date(result.nextRunAt).getTime();
  assert.ok(next > before);
  assert.ok(next - before <= 25 * 60 * 60 * 1000);
});

test("schedule_task demands exactly one of runAt and cronExpression", async () => {
  const tools = createSchedulerTools(ctx());
  const expected = {
    error:
      "Provide exactly one of 'runAt' (one-shot) or 'cronExpression' (recurring).",
  };
  // neither
  assert.deepEqual(
    await tools.schedule_task.execute?.(scheduleInput(), toolOpts),
    expected
  );
  // both
  assert.deepEqual(
    await tools.schedule_task.execute?.(
      scheduleInput({ runAt: FUTURE, cronExpression: "0 3 * * *" }),
      toolOpts
    ),
    expected
  );
});

test("schedule_task rejects a malformed cron expression", async () => {
  const tools = createSchedulerTools(ctx());
  const result = (await tools.schedule_task.execute?.(
    scheduleInput({ cronExpression: "not a cron" }),
    toolOpts
  )) as { error: string };
  assert.match(result.error, /^Invalid cron expression: "not a cron"\./);
});

test("schedule_task rejects an unparseable date and a past one", async () => {
  const tools = createSchedulerTools(ctx());
  const bad = (await tools.schedule_task.execute?.(
    scheduleInput({ runAt: "tomorrow-ish" }),
    toolOpts
  )) as { error: string };
  assert.match(bad.error, /^Invalid date: "tomorrow-ish"\./);

  assert.deepEqual(
    await tools.schedule_task.execute?.(
      scheduleInput({ runAt: "2020-01-01T00:00:00.000Z" }),
      toolOpts
    ),
    { error: "That time is in the past." }
  );
});

test("an autonomous turn with no user still attributes the task", async () => {
  const tools = createSchedulerTools(
    ctx({ channelId: "sched-anon", userId: null })
  );
  await tools.schedule_task.execute?.(
    scheduleInput({ name: "anon", runAt: FUTURE }),
    toolOpts
  );

  const listed = (await tools.list_tasks.execute?.(
    { includeDisabled: false, index: null } as never,
    toolOpts
  )) as { tasks: Array<{ createdBy: string }> };
  assert.deepEqual(
    listed.tasks.map((t) => t.createdBy),
    ["unknown"]
  );
});

test("list_tasks is channel-scoped and truncates long instructions", async () => {
  const tools = createSchedulerTools(ctx({ channelId: "sched-list" }));
  const long = "x".repeat(250);
  await tools.schedule_task.execute?.(
    scheduleInput({ name: "verbose", instruction: long, runAt: FUTURE }),
    toolOpts
  );

  const listed = (await tools.list_tasks.execute?.(
    { includeDisabled: false, index: null } as never,
    toolOpts
  )) as {
    tasks: Array<{
      name: string;
      instruction: string;
      cronExpression: string | null;
      lastRunAt: string | null;
      enabled: boolean;
    }>;
  };
  assert.equal(listed.tasks.length, 1);
  const task = listed.tasks[0];
  assert.equal(task?.name, "verbose");
  assert.equal(task?.instruction, `${"x".repeat(100)}...`);
  assert.equal(task?.cronExpression, null);
  assert.equal(task?.lastRunAt, null);
  assert.equal(task?.enabled, true);

  // a different channel sees none of it
  const elsewhere = createSchedulerTools(ctx({ channelId: "sched-elsewhere" }));
  assert.deepEqual(
    await elsewhere.list_tasks.execute?.(
      { includeDisabled: false, index: null } as never,
      toolOpts
    ),
    { tasks: [], message: "No (more) scheduled tasks in this channel." }
  );
});

test("list_tasks pages ten at a time", async () => {
  const tools = createSchedulerTools(ctx({ channelId: "sched-page" }));
  for (let i = 0; i < 12; i++) {
    await tools.schedule_task.execute?.(
      scheduleInput({ name: `task-${i}`, runAt: FUTURE }),
      toolOpts
    );
  }

  const first = (await tools.list_tasks.execute?.(
    { includeDisabled: false, index: 1 } as never,
    toolOpts
  )) as { tasks: Array<{ id: number }> };
  assert.equal(first.tasks.length, 10);

  const second = (await tools.list_tasks.execute?.(
    { includeDisabled: false, index: 2 } as never,
    toolOpts
  )) as { tasks: Array<{ id: number }> };
  assert.equal(second.tasks.length, 2);
  // pages don't overlap
  const firstIds = new Set(first.tasks.map((t) => t.id));
  assert.ok(second.tasks.every((t) => !firstIds.has(t.id)));

  // past the end
  assert.deepEqual(
    await tools.list_tasks.execute?.(
      { includeDisabled: false, index: 5 } as never,
      toolOpts
    ),
    { tasks: [], message: "No (more) scheduled tasks in this channel." }
  );
});

test("cancel_task disables a task, which then only shows with includeDisabled", async () => {
  const tools = createSchedulerTools(ctx({ channelId: "sched-cancel" }));
  const created = (await tools.schedule_task.execute?.(
    scheduleInput({ name: "doomed", runAt: FUTURE }),
    toolOpts
  )) as { id: number };

  assert.deepEqual(
    await tools.cancel_task.execute?.({ taskId: created.id }, toolOpts),
    { success: true, id: created.id, name: "doomed" }
  );

  const active = (await tools.list_tasks.execute?.(
    { includeDisabled: false, index: null } as never,
    toolOpts
  )) as { tasks: unknown[] };
  assert.equal(active.tasks.length, 0);

  const all = (await tools.list_tasks.execute?.(
    { includeDisabled: true, index: null } as never,
    toolOpts
  )) as { tasks: Array<{ id: number; enabled: boolean }> };
  assert.deepEqual(all.tasks, [
    { ...all.tasks[0], id: created.id, enabled: false },
  ]);
});

test("cancel_task refuses another user's task and an unknown id", async () => {
  const owner = createSchedulerTools(
    ctx({ channelId: "sched-own", userId: "owner" })
  );
  const created = (await owner.schedule_task.execute?.(
    scheduleInput({ name: "mine", runAt: FUTURE }),
    toolOpts
  )) as { id: number };

  const stranger = createSchedulerTools(
    ctx({ channelId: "sched-own", userId: "stranger" })
  );
  assert.deepEqual(
    await stranger.cancel_task.execute?.({ taskId: created.id }, toolOpts),
    {
      error: `Task #${created.id} not found in this channel, or you don't own it.`,
    }
  );

  // still active for its owner
  const listed = (await owner.list_tasks.execute?.(
    { includeDisabled: false, index: null } as never,
    toolOpts
  )) as { tasks: Array<{ id: number }> };
  assert.deepEqual(
    listed.tasks.map((t) => t.id),
    [created.id]
  );

  assert.deepEqual(
    await owner.cancel_task.execute?.({ taskId: 999_999 }, toolOpts),
    {
      error: "Task #999999 not found in this channel, or you don't own it.",
    }
  );
});

test("an autonomous turn may cancel a task it does not own", async () => {
  const owner = createSchedulerTools(
    ctx({ channelId: "sched-auto", userId: "someone" })
  );
  const created = (await owner.schedule_task.execute?.(
    scheduleInput({ name: "system-managed", runAt: FUTURE }),
    toolOpts
  )) as { id: number };

  // no userId means no ownership predicate to enforce
  const autonomous = createSchedulerTools(
    ctx({ channelId: "sched-auto", userId: null })
  );
  assert.deepEqual(
    await autonomous.cancel_task.execute?.({ taskId: created.id }, toolOpts),
    { success: true, id: created.id, name: "system-managed" }
  );
});

test("a syntactically valid cron that can never fire is refused", async () => {
  const tools = createSchedulerTools(ctx());
  // February 30th passes cron validation but has no next occurrence
  assert.deepEqual(
    await tools.schedule_task.execute?.(
      scheduleInput({ cronExpression: "0 0 30 2 *" }),
      toolOpts
    ),
    { error: "Could not compute next run time from the cron expression." }
  );
});

test("a write that persists nothing is reported instead of faked", async () => {
  const dbm = await import("../../../src/db/index.js");
  const spy = vi.spyOn(dbm.db, "insert").mockReturnValueOnce({
    values: () => ({ returning: async () => [] }),
  } as never);

  const tools = createSchedulerTools(ctx());
  assert.deepEqual(
    await tools.schedule_task.execute?.(
      scheduleInput({ runAt: FUTURE }),
      toolOpts
    ),
    { error: "Failed to create task." }
  );
  spy.mockRestore();
});
