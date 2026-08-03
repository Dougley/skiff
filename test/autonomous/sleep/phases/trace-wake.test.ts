import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../../helpers/setup.js";
import {
  llmQueue,
  queueError,
  queueJson,
  TOKENS_PER_CALL,
} from "./llm-mock.js";

bootstrapTestEnv({ LLM_MAX_RETRIES: "0" });

vi.mock("../../../../src/ai/llm/provider.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../../src/ai/llm/provider.js")>();
  const { MockLanguageModelV3 } = await import("ai/test");
  const { llmQueue: queue } = await import("./llm-mock.js");
  return {
    ...actual,
    getLLMProvider: () =>
      new MockLanguageModelV3({
        doGenerate: async () => {
          const next = queue.shift();
          if (next === undefined) throw new Error("llm mock queue is empty");
          if (next instanceof Error) throw next;
          return next;
        },
      }),
  };
});

import type { DreamContext } from "../../../../src/autonomous/sleep/context.js";

let dbm: typeof import("../../../../src/db/index.js");
let phase: typeof import("../../../../src/autonomous/sleep/phases/trace-wake.js");
let envm: typeof import("../../../../src/config/env.js");
let runId: number;

function makeCtx(overrides: Partial<DreamContext> = {}): DreamContext {
  return {
    runId,
    guildId: "guild-1",
    channelId: null,
    dryRun: false,
    phaseStats: {},
    tokenUsage: 0,
    now: new Date(),
    ...overrides,
  };
}

async function seedStoryline(params: {
  title: string;
  guildId?: string | null;
  channelId?: string | null;
}) {
  const [row] = await dbm.db
    .insert(dbm.storylines)
    .values({
      title: params.title,
      goal: "a goal",
      currentState: "in progress",
      guildId: params.guildId ?? null,
      channelId: params.channelId ?? null,
    })
    .returning();
  assert.ok(row);
  return row;
}

async function seedEvent(storylineId: number, summary: string) {
  const [row] = await dbm.db
    .insert(dbm.storylineEvents)
    .values({ storylineId, kind: "decision", summary, details: "details here" })
    .returning();
  assert.ok(row);
  return row;
}

async function allLinks() {
  return await dbm.db
    .select()
    .from(dbm.storylineEventLinks)
    .orderBy(dbm.storylineEventLinks.id);
}

async function wakeChanges() {
  return await dbm.db
    .select()
    .from(dbm.sleepCycleChanges)
    .where(eq(dbm.sleepCycleChanges.kind, "wake_link"))
    .orderBy(dbm.sleepCycleChanges.id);
}

beforeAll(async () => {
  const { runMigrations } = await import("../../../../src/db/migrate.js");
  await runMigrations();
  dbm = await import("../../../../src/db/index.js");
  envm = await import("../../../../src/config/env.js");
  phase = await import("../../../../src/autonomous/sleep/phases/trace-wake.js");
  const [run] = await dbm.db
    .insert(dbm.sleepCycleRuns)
    .values({ guildId: "guild-1", triggerReason: "test" })
    .returning();
  assert.ok(run);
  runId = run.id;
});

beforeEach(async () => {
  llmQueue.length = 0;
  await dbm.db.delete(dbm.sleepCycleChanges);
  await dbm.db.delete(dbm.storylineEventLinks);
  await dbm.db.delete(dbm.storylineEvents);
  await dbm.db.delete(dbm.storylines);
});

test("does nothing when the memory model is disabled", async () => {
  envm.env.MEMORY_EXTRACT_MODEL = "disabled";
  try {
    const storyline = await seedStoryline({
      title: "Disabled",
      guildId: "guild-1",
    });
    await seedEvent(storyline.id, "one");
    await seedEvent(storyline.id, "two");
    const ctx = makeCtx();
    await phase.traceWake(ctx);
    assert.deepEqual(ctx.phaseStats, {});
  } finally {
    envm.env.MEMORY_EXTRACT_MODEL = undefined;
  }
});

test("does nothing for a run with neither a guild nor a channel scope", async () => {
  const storyline = await seedStoryline({ title: "Legacy" });
  await seedEvent(storyline.id, "one");
  await seedEvent(storyline.id, "two");

  const ctx = makeCtx({ guildId: null, channelId: null });
  await phase.traceWake(ctx);

  assert.deepEqual(ctx.phaseStats, {});
  assert.deepEqual(await allLinks(), []);
});

test("returns early when the scope has fewer than two events", async () => {
  const storyline = await seedStoryline({
    title: "Sparse",
    guildId: "guild-sparse",
  });
  await seedEvent(storyline.id, "only event");

  const ctx = makeCtx({ guildId: "guild-sparse" });
  await phase.traceWake(ctx);

  assert.deepEqual(ctx.phaseStats, {});
});

test("writes the proposed links and patches the change rows with their ids", async () => {
  const storyline = await seedStoryline({
    title: "Ship it",
    guildId: "guild-wake",
  });
  const a = await seedEvent(storyline.id, "Picked PGlite");
  const b = await seedEvent(storyline.id, "Storage is embedded");
  const c = await seedEvent(storyline.id, "Dropped the Postgres container");

  queueJson({
    links: [
      {
        fromEventId: b.id,
        relation: "caused_by",
        toEventId: a.id,
        rationale: "the second event names the first as its cause",
        confidence: 95,
      },
      {
        fromEventId: c.id,
        relation: "depends_on",
        toEventId: a.id,
        rationale: "explicitly stated",
        confidence: 90,
      },
    ],
  });

  const ctx = makeCtx({ guildId: "guild-wake" });
  await phase.traceWake(ctx);

  assert.deepEqual(ctx.phaseStats.trace_wake, {
    eventsConsidered: 3,
    linksProposed: 2,
    linksWritten: 2,
  });
  assert.equal(ctx.tokenUsage, TOKENS_PER_CALL);

  const links = await allLinks();
  assert.equal(links.length, 2);
  assert.deepEqual(
    links.map((l) => [l.fromEventId, l.relation, l.toEventId]),
    [
      [b.id, "caused_by", a.id],
      [c.id, "depends_on", a.id],
    ]
  );
  assert.equal(
    links[0]?.rationale,
    "the second event names the first as its cause"
  );

  const changes = await wakeChanges();
  assert.equal(changes.length, 2);
  assert.deepEqual(
    changes.map((ch) => ch.targetId).sort(),
    links.map((l) => String(l.id)).sort()
  );
  assert.equal(changes[0]?.targetTable, "storyline_event_links");
});

test("rejects low-confidence, self-referential, out-of-scope and duplicate links", async () => {
  const storyline = await seedStoryline({
    title: "Filtering",
    guildId: "guild-filter",
  });
  const a = await seedEvent(storyline.id, "first");
  const b = await seedEvent(storyline.id, "second");

  const other = await seedStoryline({
    title: "Other guild",
    guildId: "guild-other",
  });
  const foreign = await seedEvent(other.id, "not in scope");

  // an already-recorded link the model must not duplicate
  await dbm.db.insert(dbm.storylineEventLinks).values({
    fromEventId: a.id,
    toEventId: b.id,
    relation: "supports",
    rationale: "recorded earlier",
  });

  queueJson({
    links: [
      {
        fromEventId: b.id,
        relation: "supports",
        toEventId: a.id,
        rationale: "a hunch",
        confidence: 60,
      },
      {
        fromEventId: a.id,
        relation: "supports",
        toEventId: a.id,
        rationale: "self link",
        confidence: 99,
      },
      {
        fromEventId: a.id,
        relation: "supports",
        toEventId: foreign.id,
        rationale: "crosses guilds",
        confidence: 99,
      },
      {
        fromEventId: 999_999,
        relation: "supports",
        toEventId: b.id,
        rationale: "unknown source event",
        confidence: 99,
      },
      {
        fromEventId: a.id,
        relation: "supports",
        toEventId: b.id,
        rationale: "already known",
        confidence: 99,
      },
    ],
  });

  const ctx = makeCtx({ guildId: "guild-filter" });
  await phase.traceWake(ctx);

  assert.deepEqual(ctx.phaseStats.trace_wake, { eventsConsidered: 2 });
  assert.equal((await allLinks()).length, 1);
  assert.deepEqual(await wakeChanges(), []);
});

test("links events in a DM-scoped run", async () => {
  const storyline = await seedStoryline({
    title: "DM plan",
    guildId: null,
    channelId: "dm-wake",
  });
  const a = await seedEvent(storyline.id, "agreed on the outline");
  const b = await seedEvent(storyline.id, "wrote the outline");

  queueJson({
    links: [
      {
        fromEventId: b.id,
        relation: "supports",
        toEventId: a.id,
        rationale: "stated in the event text",
        confidence: 100,
      },
    ],
  });

  const ctx = makeCtx({ guildId: null, channelId: "dm-wake" });
  await phase.traceWake(ctx);

  assert.equal(ctx.phaseStats.trace_wake?.linksWritten, 1);
  const links = await allLinks();
  assert.equal(links.length, 1);
  assert.equal(links[0]?.fromEventId, b.id);
});

test("degrades gracefully when the LLM call fails", async () => {
  const storyline = await seedStoryline({
    title: "Broken",
    guildId: "guild-err",
  });
  await seedEvent(storyline.id, "first");
  await seedEvent(storyline.id, "second");

  queueError("provider exploded");

  const ctx = makeCtx({ guildId: "guild-err" });
  await phase.traceWake(ctx);

  assert.deepEqual(ctx.phaseStats.trace_wake, { eventsConsidered: 2 });
  assert.equal(ctx.tokenUsage, 0);
  assert.deepEqual(await allLinks(), []);
});

test("degrades gracefully when the LLM output does not match the schema", async () => {
  const storyline = await seedStoryline({
    title: "Bad schema",
    guildId: "guild-badschema",
  });
  const a = await seedEvent(storyline.id, "first");
  const b = await seedEvent(storyline.id, "second");

  // "inspired_by" is not one of the Wake relations
  queueJson({
    links: [
      {
        fromEventId: b.id,
        relation: "inspired_by",
        toEventId: a.id,
        rationale: "invented relation",
        confidence: 99,
      },
    ],
  });

  const ctx = makeCtx({ guildId: "guild-badschema" });
  await phase.traceWake(ctx);

  assert.deepEqual(ctx.phaseStats.trace_wake, { eventsConsidered: 2 });
  assert.deepEqual(await allLinks(), []);
});

test("dry run logs the proposal without writing the link", async () => {
  const storyline = await seedStoryline({
    title: "Dry",
    guildId: "guild-drywake",
  });
  const a = await seedEvent(storyline.id, "first");
  const b = await seedEvent(storyline.id, "second");

  queueJson({
    links: [
      {
        fromEventId: b.id,
        relation: "supersedes",
        toEventId: a.id,
        rationale: "explicit",
        confidence: 99,
      },
    ],
  });

  const ctx = makeCtx({ guildId: "guild-drywake", dryRun: true });
  await phase.traceWake(ctx);

  assert.deepEqual(ctx.phaseStats.trace_wake, {
    eventsConsidered: 2,
    linksProposed: 1,
  });
  assert.deepEqual(await allLinks(), []);

  const changes = await wakeChanges();
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.targetId, null);
  assert.equal(changes[0]?.after?.relation, "supersedes");
});
