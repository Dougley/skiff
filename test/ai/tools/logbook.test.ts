import assert from "node:assert/strict";
import type { Client } from "discord.js";
import { beforeAll, test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const toolOpts = { toolCallId: "test-call", messages: [] } as never;

let createLogbookTools: typeof import("../../../src/ai/tools/logbook.js").createLogbookTools;
let dbm: typeof import("../../../src/db/index.js");

beforeAll(async () => {
  const [{ runMigrations }, tools, db] = await Promise.all([
    import("../../../src/db/migrate.js"),
    import("../../../src/ai/tools/logbook.js"),
    import("../../../src/db/index.js"),
  ]);
  await runMigrations();
  createLogbookTools = tools.createLogbookTools;
  dbm = db;
});

/** A tool context in a guild channel, with an optional provenance message. */
function ctx(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    client: {} as Client,
    guildId: "lb-guild",
    channelId: "lb-channel",
    userId: "lb-user",
    ...overrides,
  } as import("../../../src/ai/tools/discord.js").DiscordToolContext;
}

/** Persist a real message row so wake_add_evidence has something to point at. */
async function seedMessage(scope: {
  guildId: string | null;
  channelId: string;
}): Promise<number> {
  const [conversation] = await dbm.db
    .insert(dbm.conversations)
    .values({ ...scope, model: "test-model" })
    .returning();
  assert.ok(conversation);
  const [message] = await dbm.db
    .insert(dbm.messages)
    .values({
      conversationId: conversation.id,
      role: "user",
      content: "the message that started it",
      userId: "lb-user",
    })
    .returning();
  assert.ok(message);
  return message.id;
}

type CreateResult = { success: true; storylineId: number; title: string };

async function createStoryline(
  tools: ReturnType<typeof createLogbookTools>,
  title: string,
  extra: Record<string, unknown> = {}
): Promise<number> {
  const created = (await tools.logbook_create.execute?.(
    {
      title,
      goal: `goal for ${title}`,
      currentState: "just started",
      ownerUserIds: [],
      tags: [],
      ...extra,
    } as never,
    toolOpts
  )) as CreateResult;
  assert.equal(created.success, true);
  return created.storylineId;
}

test("logbook_create then logbook_list surfaces the new storyline", async () => {
  const tools = createLogbookTools(ctx({ channelId: "lb-create" }));
  const id = await createStoryline(tools, "Ship the thing", {
    ownerUserIds: ["lb-user"],
    tags: ["release"],
  });

  const listed = (await tools.logbook_list.execute?.(
    { includeClosed: false },
    toolOpts
  )) as { storylines: Array<Record<string, unknown>> };

  const row = listed.storylines.find((s) => s.id === id);
  assert.ok(row, "the storyline should be listed");
  assert.equal(row.title, "Ship the thing");
  assert.equal(row.goal, "goal for Ship the thing");
  assert.equal(row.currentState, "just started");
  assert.equal(row.status, "open");
  assert.deepEqual(row.owners, ["lb-user"]);
  assert.deepEqual(row.tags, ["release"]);
  // serialized, not a Date — the model only ever sees JSON
  assert.equal(typeof row.lastActivityAt, "string");
});

test("logbook_list hides closed storylines unless asked", async () => {
  const tools = createLogbookTools(ctx({ channelId: "lb-closed" }));
  const id = await createStoryline(tools, "Finished business");
  await tools.logbook_record.execute?.(
    {
      storylineId: id,
      kind: "milestone",
      summary: "shipped",
      details: null,
      ownerUserId: null,
      dueAt: null,
      currentState: null,
      storylineStatus: "completed",
    } as never,
    toolOpts
  );

  const open = (await tools.logbook_list.execute?.(
    { includeClosed: false },
    toolOpts
  )) as { storylines: Array<{ id: number }> };
  assert.ok(!open.storylines.some((s) => s.id === id));

  const all = (await tools.logbook_list.execute?.(
    { includeClosed: true },
    toolOpts
  )) as { storylines: Array<{ id: number; status: string }> };
  const row = all.storylines.find((s) => s.id === id);
  assert.equal(row?.status, "completed");
});

test("logbook_get returns the storyline with its serialized event history", async () => {
  const tools = createLogbookTools(ctx({ channelId: "lb-get" }));
  const id = await createStoryline(tools, "Investigate the leak");
  const recorded = (await tools.logbook_record.execute?.(
    {
      storylineId: id,
      kind: "commitment",
      summary: "audit the pool",
      details: "check every checkout path",
      ownerUserId: "lb-user",
      dueAt: "2030-01-01T00:00:00.000Z",
      currentState: "auditing",
      storylineStatus: null,
    } as never,
    toolOpts
  )) as { success: true; eventId: number; currentState: string };
  assert.equal(recorded.currentState, "auditing");

  const result = (await tools.logbook_get.execute?.(
    { storylineId: id },
    toolOpts
  )) as {
    storyline: Record<string, unknown>;
    events: Array<Record<string, unknown>>;
  };

  assert.equal(result.storyline.id, id);
  assert.equal(result.storyline.currentState, "auditing");
  const event = result.events.find((e) => e.id === recorded.eventId);
  assert.ok(event);
  assert.equal(event.kind, "commitment");
  assert.equal(event.summary, "audit the pool");
  assert.equal(event.dueAt, "2030-01-01T00:00:00.000Z");
  assert.equal(event.resolvedAt, null);
  assert.equal(typeof event.createdAt, "string");
});

test("a storyline in another scope is invisible, not merely empty", async () => {
  const owner = createLogbookTools(ctx({ channelId: "lb-scope-a" }));
  const id = await createStoryline(owner, "Guild-only plan");

  // a DM sees neither the storyline nor its events
  const outsider = createLogbookTools(
    ctx({ guildId: null, channelId: "lb-dm" })
  );
  assert.deepEqual(
    await outsider.logbook_get.execute?.({ storylineId: id }, toolOpts),
    { error: "Storyline not found in this scope." }
  );
  assert.deepEqual(
    await outsider.logbook_record.execute?.(
      {
        storylineId: id,
        kind: "note",
        summary: "sneaking in",
        details: null,
        ownerUserId: null,
        dueAt: null,
        currentState: null,
        storylineStatus: null,
      } as never,
      toolOpts
    ),
    { error: "Storyline not found in this scope." }
  );
});

test("logbook_resolve closes an open loop and refuses a second attempt", async () => {
  const tools = createLogbookTools(ctx({ channelId: "lb-resolve" }));
  const id = await createStoryline(tools, "Open questions");
  const question = (await tools.logbook_record.execute?.(
    {
      storylineId: id,
      kind: "open_question",
      summary: "do we need a migration?",
      details: null,
      ownerUserId: null,
      dueAt: null,
      currentState: null,
      storylineStatus: null,
    } as never,
    toolOpts
  )) as { eventId: number };

  const resolved = (await tools.logbook_resolve.execute?.(
    {
      storylineId: id,
      eventId: question.eventId,
      resolution: "no — the column is nullable",
    } as never,
    toolOpts
  )) as { success: true; resolvedEventId: number };
  assert.equal(resolved.resolvedEventId, question.eventId);

  // already resolved: no longer an active event
  assert.deepEqual(
    await tools.logbook_resolve.execute?.(
      { storylineId: id, eventId: question.eventId, resolution: null } as never,
      toolOpts
    ),
    { error: "Active event or storyline not found in this scope." }
  );

  const after = (await tools.logbook_get.execute?.(
    { storylineId: id },
    toolOpts
  )) as { events: Array<{ id: number; resolvedAt: string | null }> };
  const event = after.events.find((e) => e.id === question.eventId);
  assert.equal(typeof event?.resolvedAt, "string");
});

test("wake_link connects two events and wake_why traces the link back", async () => {
  const tools = createLogbookTools(ctx({ channelId: "lb-wake" }));
  const id = await createStoryline(tools, "Architecture");

  const record = async (summary: string) =>
    (
      (await tools.logbook_record.execute?.(
        {
          storylineId: id,
          kind: "decision",
          summary,
          details: null,
          ownerUserId: null,
          dueAt: null,
          currentState: null,
          storylineStatus: null,
        } as never,
        toolOpts
      )) as { eventId: number }
    ).eventId;

  const cause = await record("we chose Postgres");
  const effect = await record("we dropped the cache layer");

  const link = (await tools.wake_link.execute?.(
    {
      fromEventId: effect,
      relation: "caused_by",
      toEventId: cause,
      rationale: "the database already does this",
    } as never,
    toolOpts
  )) as { success: true; linkId: number };
  assert.equal(link.success, true);

  const graph = (await tools.wake_why.execute?.(
    { eventId: effect, depth: 3 } as never,
    toolOpts
  )) as {
    rootEventId: number;
    events: Array<{ id: number; summary: string }>;
    links: Array<Record<string, unknown>>;
  };

  assert.equal(graph.rootEventId, effect);
  // the traversal pulls in the linked cause, not just the root
  assert.deepEqual(
    graph.events.map((e) => e.id).sort((a, b) => a - b),
    [cause, effect].sort((a, b) => a - b)
  );
  assert.deepEqual(graph.links, [
    {
      fromEventId: effect,
      relation: "caused_by",
      toEventId: cause,
      rationale: "the database already does this",
    },
  ]);
});

test("wake_link rejects self-links and cross-scope events", async () => {
  const tools = createLogbookTools(ctx({ channelId: "lb-badlink" }));
  const id = await createStoryline(tools, "Linking rules");
  const event = (
    (await tools.logbook_record.execute?.(
      {
        storylineId: id,
        kind: "note",
        summary: "solitary",
        details: null,
        ownerUserId: null,
        dueAt: null,
        currentState: null,
        storylineStatus: null,
      } as never,
      toolOpts
    )) as { eventId: number }
  ).eventId;

  const expected = {
    error: "Both events must be distinct and belong to this server or DM.",
  };
  assert.deepEqual(
    await tools.wake_link.execute?.(
      {
        fromEventId: event,
        relation: "supports",
        toEventId: event,
        rationale: null,
      } as never,
      toolOpts
    ),
    expected
  );
  assert.deepEqual(
    await tools.wake_link.execute?.(
      {
        fromEventId: event,
        relation: "supports",
        toEventId: 999_999,
        rationale: null,
      } as never,
      toolOpts
    ),
    expected
  );
});

test("wake_why reports a missing event rather than an empty graph", async () => {
  const tools = createLogbookTools(ctx({ channelId: "lb-missing" }));
  assert.deepEqual(
    await tools.wake_why.execute?.(
      { eventId: 999_999, depth: 1 } as never,
      toolOpts
    ),
    { error: "Event not found in this scope." }
  );
});

test("wake_add_evidence attaches the current message and shows up as evidence", async () => {
  const scope = { guildId: "lb-guild", channelId: "lb-evidence" };
  const messageId = await seedMessage(scope);
  const tools = createLogbookTools(
    ctx({ ...scope, sourceMessageId: messageId })
  );

  const id = await createStoryline(tools, "Evidence trail");
  const eventId = (
    (await tools.logbook_record.execute?.(
      {
        storylineId: id,
        kind: "risk",
        summary: "the pool may leak",
        details: null,
        ownerUserId: null,
        dueAt: null,
        currentState: null,
        storylineStatus: null,
      } as never,
      toolOpts
    )) as { eventId: number }
  ).eventId;

  assert.deepEqual(
    await tools.wake_add_evidence.execute?.(
      { eventId, note: "confirmed in production" } as never,
      toolOpts
    ),
    { success: true, eventId }
  );

  const graph = (await tools.wake_why.execute?.(
    { eventId, depth: 1 } as never,
    toolOpts
  )) as { events: Array<{ id: number; evidence: unknown[] }> };
  const node = graph.events.find((e) => e.id === eventId);
  assert.ok(node);
  assert.ok(
    node.evidence.length > 0,
    "the attached message should be evidence"
  );

  // an unknown event id is refused
  assert.deepEqual(
    await tools.wake_add_evidence.execute?.(
      { eventId: 999_999, note: null } as never,
      toolOpts
    ),
    { error: "Event not found in this scope." }
  );
});

test("wake_add_evidence needs a source message to attach", async () => {
  const tools = createLogbookTools(ctx({ channelId: "lb-no-source" }));
  assert.deepEqual(
    await tools.wake_add_evidence.execute?.(
      { eventId: 1, note: null } as never,
      toolOpts
    ),
    { error: "No source message available." }
  );
});

test("an autonomous turn records without an actor or a source message", async () => {
  // no user and no provenance message: every attribution falls back to null
  const tools = createLogbookTools(
    ctx({ channelId: "lb-autonomous", userId: null, sourceMessageId: null })
  );
  const id = await createStoryline(tools, "Unattended watch");

  const first = (await tools.logbook_record.execute?.(
    {
      storylineId: id,
      kind: "note",
      summary: "the heartbeat noticed something",
      details: null,
      ownerUserId: null,
      dueAt: null,
      currentState: null,
      storylineStatus: null,
    } as never,
    toolOpts
  )) as { success: true; eventId: number };
  const second = (await tools.logbook_record.execute?.(
    {
      storylineId: id,
      kind: "risk",
      summary: "and flagged it",
      details: null,
      ownerUserId: null,
      dueAt: null,
      currentState: null,
      storylineStatus: null,
    } as never,
    toolOpts
  )) as { eventId: number };

  assert.equal(first.success, true);

  const link = (await tools.wake_link.execute?.(
    {
      fromEventId: second.eventId,
      relation: "depends_on",
      toEventId: first.eventId,
      rationale: null,
    } as never,
    toolOpts
  )) as { success: true; linkId: number };
  assert.equal(link.success, true);
  assert.equal(typeof link.linkId, "number");

  // the unattributed work is still fully readable afterwards
  const graph = (await tools.wake_why.execute?.(
    { eventId: second.eventId, depth: 2 } as never,
    toolOpts
  )) as { links: Array<Record<string, unknown>> };
  assert.deepEqual(graph.links, [
    {
      fromEventId: second.eventId,
      relation: "depends_on",
      toEventId: first.eventId,
      rationale: null,
    },
  ]);

  // and with no source message there is nothing to attach as evidence
  assert.deepEqual(
    await tools.wake_add_evidence.execute?.(
      { eventId: first.eventId, note: null } as never,
      toolOpts
    ),
    { error: "No source message available." }
  );
});
