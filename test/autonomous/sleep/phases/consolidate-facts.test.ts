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
let phase: typeof import("../../../../src/autonomous/sleep/phases/consolidate-facts.js");
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

async function seedConversation(channelId: string, guildId: string | null) {
  const [conversation] = await dbm.db
    .insert(dbm.conversations)
    .values({ channelId, guildId, model: "test" })
    .returning();
  assert.ok(conversation);
  return conversation;
}

async function seedUserMessage(conversationId: string, userId: string) {
  await dbm.db
    .insert(dbm.messages)
    .values({ conversationId, role: "user", content: "hello", userId });
}

async function seedFact(params: {
  userId: string;
  fact: string;
  guildId?: string | null;
  channelId?: string | null;
  confidence?: number;
}) {
  const [row] = await dbm.db
    .insert(dbm.userFacts)
    .values({
      userId: params.userId,
      fact: params.fact,
      guildId: params.guildId ?? null,
      channelId: params.channelId ?? null,
      confidence: params.confidence ?? 80,
      category: "preference",
    })
    .returning();
  assert.ok(row);
  return row;
}

async function factById(id: number) {
  const [row] = await dbm.db
    .select()
    .from(dbm.userFacts)
    .where(eq(dbm.userFacts.id, id));
  assert.ok(row);
  return row;
}

beforeAll(async () => {
  const { runMigrations } = await import("../../../../src/db/migrate.js");
  await runMigrations();
  dbm = await import("../../../../src/db/index.js");
  envm = await import("../../../../src/config/env.js");
  phase = await import(
    "../../../../src/autonomous/sleep/phases/consolidate-facts.js"
  );
  const [run] = await dbm.db
    .insert(dbm.sleepCycleRuns)
    .values({ guildId: "guild-1", triggerReason: "test" })
    .returning();
  assert.ok(run);
  runId = run.id;
});

beforeEach(() => {
  llmQueue.length = 0;
});

test("does nothing when the memory model is disabled", async () => {
  envm.env.MEMORY_EXTRACT_MODEL = "disabled";
  try {
    const ctx = makeCtx();
    await phase.consolidateFacts(ctx);
    assert.deepEqual(ctx.phaseStats, {});
    assert.equal(ctx.tokenUsage, 0);
  } finally {
    envm.env.MEMORY_EXTRACT_MODEL = undefined;
  }
});

test("retires contradicted facts in guild scope and logs the resolution", async () => {
  const conversation = await seedConversation("chan-1", "guild-1");
  await seedUserMessage(conversation.id, "user-1");
  const keep = await seedFact({
    userId: "user-1",
    fact: "favorite color is blue",
    guildId: "guild-1",
  });
  const retire = await seedFact({
    userId: "user-1",
    fact: "favorite color is red",
    guildId: "guild-1",
  });
  // second user with a message but too few facts — skipped before the LLM
  await seedUserMessage(conversation.id, "user-2");
  await seedFact({ userId: "user-2", fact: "single fact", guildId: "guild-1" });

  queueJson({
    resolutions: [
      {
        keepId: keep.id,
        // keepId and an unknown id must be filtered from retireIds
        retireIds: [retire.id, keep.id, 999999],
        reason: "blue is newer",
      },
    ],
  });

  const ctx = makeCtx();
  await phase.consolidateFacts(ctx);

  assert.deepEqual(ctx.phaseStats.consolidate_facts, {
    usersScanned: 1,
    resolutions: 1,
    factsRetired: 1,
  });
  assert.equal(ctx.tokenUsage, TOKENS_PER_CALL);

  const retired = await factById(retire.id);
  assert.equal(retired.active, false);
  assert.equal(retired.supersededBy, keep.id);
  const kept = await factById(keep.id);
  assert.equal(kept.active, true);

  const changes = await dbm.db
    .select()
    .from(dbm.sleepCycleChanges)
    .where(eq(dbm.sleepCycleChanges.kind, "fact_resolve"));
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.targetId, String(keep.id));
  assert.deepEqual(changes[0]?.before, {
    retireIds: [retire.id],
    keepId: keep.id,
  });
});

test("ignores resolutions with unknown keepId or no valid retirees (DM scope)", async () => {
  const conversation = await seedConversation("dm-1", null);
  await seedUserMessage(conversation.id, "user-3");
  const a = await seedFact({
    userId: "user-3",
    fact: "likes tea",
    channelId: "dm-1",
  });
  const b = await seedFact({
    userId: "user-3",
    fact: "likes coffee",
    channelId: "dm-1",
  });

  queueJson({
    resolutions: [
      { keepId: 999999, retireIds: [a.id], reason: "unknown keeper" },
      { keepId: a.id, retireIds: [a.id], reason: "self-retire only" },
    ],
  });

  const ctx = makeCtx({ guildId: null, channelId: "dm-1" });
  await phase.consolidateFacts(ctx);

  assert.deepEqual(ctx.phaseStats.consolidate_facts, { usersScanned: 1 });
  assert.equal((await factById(a.id)).active, true);
  assert.equal((await factById(b.id)).active, true);
});

test("continues gracefully when the LLM call fails (legacy scope)", async () => {
  const conversation = await seedConversation("dm-legacy", null);
  await seedUserMessage(conversation.id, "user-4");
  const a = await seedFact({ userId: "user-4", fact: "is left-handed" });
  const b = await seedFact({ userId: "user-4", fact: "is right-handed" });

  queueError("llm down");

  const ctx = makeCtx({ guildId: null, channelId: null });
  await phase.consolidateFacts(ctx);

  assert.equal(ctx.phaseStats.consolidate_facts?.usersScanned, 1);
  assert.equal(ctx.phaseStats.consolidate_facts?.resolutions, undefined);
  assert.equal((await factById(a.id)).active, true);
  assert.equal((await factById(b.id)).active, true);
  assert.equal(ctx.tokenUsage, 0);
});

test("dry run logs the change without touching facts", async () => {
  const conversation = await seedConversation("chan-dry", "guild-dry");
  await seedUserMessage(conversation.id, "user-5");
  const keep = await seedFact({
    userId: "user-5",
    fact: "prefers dark mode",
    guildId: "guild-dry",
  });
  const retire = await seedFact({
    userId: "user-5",
    fact: "prefers light mode",
    guildId: "guild-dry",
  });

  queueJson({
    resolutions: [
      { keepId: keep.id, retireIds: [retire.id], reason: "newer statement" },
    ],
  });

  const ctx = makeCtx({ guildId: "guild-dry", dryRun: true });
  await phase.consolidateFacts(ctx);

  assert.deepEqual(ctx.phaseStats.consolidate_facts, {
    usersScanned: 1,
    resolutions: 1,
  });
  assert.equal((await factById(retire.id)).active, true);
  assert.equal((await factById(retire.id)).supersededBy, null);

  const changes = await dbm.db
    .select()
    .from(dbm.sleepCycleChanges)
    .where(eq(dbm.sleepCycleChanges.targetId, String(keep.id)));
  assert.equal(changes.length, 1);
});
