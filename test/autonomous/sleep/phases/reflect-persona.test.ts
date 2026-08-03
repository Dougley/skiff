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
let phase: typeof import("../../../../src/autonomous/sleep/phases/reflect-persona.js");
let addenda: typeof import("../../../../src/autonomous/sleep/addenda.js");
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

/** Seed a conversation plus `count` alternating messages inside it. */
async function seedConversationWithMessages(
  channelId: string,
  guildId: string | null,
  count: number
) {
  const [conversation] = await dbm.db
    .insert(dbm.conversations)
    .values({ channelId, guildId, model: "test" })
    .returning();
  assert.ok(conversation);
  for (let i = 0; i < count; i++) {
    await dbm.db.insert(dbm.messages).values({
      conversationId: conversation.id,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i} in ${channelId}`,
      userId: i % 2 === 0 ? "user-1" : null,
    });
  }
  return conversation;
}

function addendum(text: string, confidence: number) {
  return { text, reason: `because of ${text}`, confidence };
}

async function activeAddenda() {
  return await dbm.db
    .select()
    .from(dbm.personaAddenda)
    .where(eq(dbm.personaAddenda.active, true))
    .orderBy(dbm.personaAddenda.id);
}

async function addendumChanges() {
  return await dbm.db
    .select()
    .from(dbm.sleepCycleChanges)
    .where(eq(dbm.sleepCycleChanges.kind, "persona_addendum"))
    .orderBy(dbm.sleepCycleChanges.id);
}

beforeAll(async () => {
  const { runMigrations } = await import("../../../../src/db/migrate.js");
  await runMigrations();
  dbm = await import("../../../../src/db/index.js");
  envm = await import("../../../../src/config/env.js");
  addenda = await import("../../../../src/autonomous/sleep/addenda.js");
  phase = await import(
    "../../../../src/autonomous/sleep/phases/reflect-persona.js"
  );
  const [run] = await dbm.db
    .insert(dbm.sleepCycleRuns)
    .values({ guildId: "guild-1", triggerReason: "test" })
    .returning();
  assert.ok(run);
  runId = run.id;
});

// Scope filters overlap (a DM conversation and a legacy one both have
// guild_id null), so each test starts from an empty transcript.
beforeEach(async () => {
  llmQueue.length = 0;
  await dbm.db.delete(dbm.sleepCycleChanges);
  await dbm.db.delete(dbm.messages);
  await dbm.db.delete(dbm.conversations);
  await dbm.db.delete(dbm.personaAddenda);
});

test("does nothing when the memory model is disabled", async () => {
  envm.env.MEMORY_EXTRACT_MODEL = "disabled";
  try {
    await seedConversationWithMessages("chan-disabled", "guild-1", 12);
    const ctx = makeCtx();
    await phase.reflectPersona(ctx);
    assert.deepEqual(ctx.phaseStats, {});
    assert.deepEqual(await activeAddenda(), []);
  } finally {
    envm.env.MEMORY_EXTRACT_MODEL = undefined;
  }
});

test("skips scopes with too little recent conversation", async () => {
  await seedConversationWithMessages("chan-quiet", "guild-1", 9);

  const ctx = makeCtx();
  await phase.reflectPersona(ctx);

  assert.deepEqual(ctx.phaseStats.reflect_persona, { skippedLowSignal: 1 });
  assert.equal(llmQueue.length, 0);
});

test("writes high-confidence addenda, capped per run, and refreshes the cache", async () => {
  await seedConversationWithMessages("chan-reflect", "guild-reflect", 12);

  queueJson({
    addenda: [
      addendum("Answers shortest-first unless asked for depth.", 90),
      addendum("Names the tradeoff before the recommendation.", 80),
      addendum("Cites the file it read.", 75),
      addendum("A fourth note beyond the per-run cap.", 95),
      addendum("Low confidence guess.", 40),
    ],
  });

  const ctx = makeCtx({ guildId: "guild-reflect" });
  await phase.reflectPersona(ctx);

  assert.deepEqual(ctx.phaseStats.reflect_persona, {
    messagesConsidered: 12,
    addendaLogged: 3,
    addendaWritten: 3,
  });
  assert.equal(ctx.tokenUsage, TOKENS_PER_CALL);

  const rows = await activeAddenda();
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.text),
    [
      "Answers shortest-first unless asked for depth.",
      "Names the tradeoff before the recommendation.",
      "Cites the file it read.",
    ]
  );
  assert.equal(rows[0]?.guildId, "guild-reflect");
  assert.equal(rows[0]?.confidence, 90);
  assert.equal(rows[0]?.sourceRunId, runId);

  // every change row got patched with the id of the addendum it created
  const changes = await addendumChanges();
  assert.equal(changes.length, 3);
  assert.deepEqual(
    changes.map((c) => c.targetId).sort(),
    rows.map((r) => String(r.id)).sort()
  );

  assert.deepEqual(
    addenda.getActiveAddenda("guild-reflect", null).guild,
    rows.map((r) => r.text)
  );
});

test("mentions the addenda already on file so the model does not restate them", async () => {
  await seedConversationWithMessages("chan-existing", "guild-existing", 10);
  await dbm.db.insert(dbm.personaAddenda).values({
    guildId: "guild-existing",
    text: "Already knows to keep answers short.",
    confidence: 90,
    active: true,
  });

  queueJson({ addenda: [addendum("Something genuinely new.", 88)] });

  const ctx = makeCtx({ guildId: "guild-existing" });
  await phase.reflectPersona(ctx);

  assert.equal(ctx.phaseStats.reflect_persona?.addendaWritten, 1);
  const rows = await activeAddenda();
  assert.equal(rows.length, 2);
});

test("records nothing when no proposal clears the confidence bar (DM scope)", async () => {
  await seedConversationWithMessages("dm-reflect", null, 10);

  queueJson({
    addenda: [addendum("Barely a hunch.", 30), addendum("Also weak.", 69)],
  });

  const ctx = makeCtx({ guildId: null, channelId: "dm-reflect" });
  await phase.reflectPersona(ctx);

  assert.deepEqual(ctx.phaseStats.reflect_persona, {
    messagesConsidered: 10,
    noQualifying: 1,
  });
  assert.deepEqual(await activeAddenda(), []);
});

test("scopes written addenda to a DM channel", async () => {
  await seedConversationWithMessages("dm-scoped", null, 10);

  queueJson({ addenda: [addendum("Keeps DM replies casual.", 92)] });

  const ctx = makeCtx({ guildId: null, channelId: "dm-scoped" });
  await phase.reflectPersona(ctx);

  const rows = await activeAddenda();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.guildId, null);
  assert.equal(rows[0]?.channelId, "dm-scoped");
  assert.deepEqual(addenda.getActiveAddenda(null, "dm-scoped").channel, [
    "Keeps DM replies casual.",
  ]);
});

test("degrades gracefully when the LLM call fails (legacy scope)", async () => {
  await seedConversationWithMessages("legacy-chan", null, 10);

  queueError("provider exploded");

  const ctx = makeCtx({ guildId: null, channelId: null });
  await phase.reflectPersona(ctx);

  assert.deepEqual(ctx.phaseStats.reflect_persona, { messagesConsidered: 10 });
  assert.equal(ctx.tokenUsage, 0);
  assert.deepEqual(await activeAddenda(), []);
});

test("degrades gracefully when the LLM output does not match the schema", async () => {
  await seedConversationWithMessages("chan-badschema", "guild-1", 10);

  queueJson({ addenda: [{ text: "no reason field", confidence: 90 }] });

  const ctx = makeCtx();
  await phase.reflectPersona(ctx);

  assert.deepEqual(ctx.phaseStats.reflect_persona, { messagesConsidered: 10 });
  assert.deepEqual(await activeAddenda(), []);
});

test("dry run logs the addendum without writing it", async () => {
  await seedConversationWithMessages("chan-dry", "guild-dry", 10);

  queueJson({ addenda: [addendum("Would be remembered.", 95)] });

  const ctx = makeCtx({ guildId: "guild-dry", dryRun: true });
  await phase.reflectPersona(ctx);

  assert.deepEqual(ctx.phaseStats.reflect_persona, {
    messagesConsidered: 10,
    addendaLogged: 1,
  });
  assert.deepEqual(await activeAddenda(), []);

  const changes = await addendumChanges();
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.targetId, null);
  assert.equal(changes[0]?.after?.text, "Would be remembered.");
});
