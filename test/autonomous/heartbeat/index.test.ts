import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { Client } from "discord.js";
import { afterEach, beforeAll, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

const turn = vi.hoisted(() => ({ handleConversationTurn: vi.fn() }));
vi.mock("../../../src/ai/llm/conversation-turn.js", () => turn);

const CHECKLIST_PATH = fileURLToPath(
  new URL("../../fixtures/heartbeat-checklist.md", import.meta.url)
);

bootstrapTestEnv({
  HEARTBEAT_ENABLED: "true",
  HEARTBEAT_CHECKLIST_PATH: CHECKLIST_PATH,
  // start == end -> no quiet hours, ticks always run
  HEARTBEAT_QUIET_HOURS_START: "00:00",
  HEARTBEAT_QUIET_HOURS_END: "00:00",
  HEARTBEAT_ACK_MAX_CHARS: "40",
});

let heartbeat: typeof import("../../../src/autonomous/heartbeat/index.js");
let env: typeof import("../../../src/config/env.js").env;
let db: typeof import("../../../src/db/index.js").db;
let heartbeatChannels: typeof import("../../../src/db/index.js").heartbeatChannels;

beforeAll(async () => {
  const { runMigrations } = await import("../../../src/db/migrate.js");
  await runMigrations();
  heartbeat = await import("../../../src/autonomous/heartbeat/index.js");
  ({ env } = await import("../../../src/config/env.js"));
  ({ db, heartbeatChannels } = await import("../../../src/db/index.js"));
});

afterEach(async () => {
  heartbeat.stopHeartbeat();
  vi.useRealTimers();
  turn.handleConversationTurn.mockReset();
  await db.delete(heartbeatChannels);
  env.HEARTBEAT_ENABLED = true;
  env.HEARTBEAT_QUIET_HOURS_START = "00:00";
  env.HEARTBEAT_QUIET_HOURS_END = "00:00";
  env.HEARTBEAT_CHECKLIST_PATH = CHECKLIST_PATH;
  env.HEARTBEAT_TIMEZONE = "UTC";
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

async function addChannel(
  channelId: string,
  guildId: string | null,
  enabled = true
) {
  await db.insert(heartbeatChannels).values({ channelId, guildId, enabled });
}

test("a disabled heartbeat never ticks", async () => {
  env.HEARTBEAT_ENABLED = false;
  await addChannel("chan-a", "guild-1");
  const client = makeClient(async () => makeChannel());

  heartbeat.startHeartbeat(client);
  await flush();

  assert.equal(client.channels.fetch.mock.calls.length, 0);
  assert.equal(turn.handleConversationTurn.mock.calls.length, 0);
  heartbeat.stopHeartbeat(); // no handle registered -> harmless no-op
});

test("the heartbeat skips when no channels are enabled", async () => {
  await addChannel("chan-off", "guild-1", false);
  const client = makeClient(async () => makeChannel());

  heartbeat.startHeartbeat(client);
  await flush();

  assert.equal(turn.handleConversationTurn.mock.calls.length, 0);
});

test("the heartbeat skips outside active hours", async () => {
  // active only at exactly 23:59 -> effectively always quiet
  env.HEARTBEAT_QUIET_HOURS_START = "00:00";
  env.HEARTBEAT_QUIET_HOURS_END = "23:59";
  await addChannel("chan-a", "guild-1");
  const client = makeClient(async () => makeChannel());

  heartbeat.startHeartbeat(client);
  await flush();

  assert.equal(turn.handleConversationTurn.mock.calls.length, 0);
});

test("a tick runs a checklist-informed turn per enabled channel and posts alerts", async () => {
  await addChannel("chan-a", "guild-1");
  await addChannel("chan-off", "guild-1", false);
  const channel = makeChannel();
  const client = makeClient(async () => channel);
  turn.handleConversationTurn.mockResolvedValue(
    turnResult("Something needs attention on deck")
  );

  heartbeat.startHeartbeat(client);
  await waitFor(
    () => turn.handleConversationTurn.mock.calls.length > 0,
    "the turn to run"
  );
  await waitFor(() => channel.send.mock.calls.length > 0, "the alert to send");

  // the disabled channel never gets a turn
  assert.equal(turn.handleConversationTurn.mock.calls.length, 1);
  const params = turn.handleConversationTurn.mock.calls[0]?.[0];
  assert.match(params.content, /\[HEARTBEAT CHECK\]/);
  assert.match(params.content, /standing instructions from HEARTBEAT\.md/);
  assert.match(params.content, /Check the bilge pumps/);
  assert.equal(params.userId, "bot-id");
  assert.equal(params.channelId, "chan-a");
  assert.equal(params.guildId, "guild-1");
  assert.equal(params.skipMemory, true);
  assert.equal(params.skipInitialStatus, true);
  assert.equal(params.messageContext.channelName, "#general");
  assert.equal(params.messageContext.guildName, "Test Guild");
  assert.equal(params.messageContext.isDM, false);

  assert.equal(channel.send.mock.calls.length, 1);
  const sent = channel.send.mock.calls[0]?.[0] as { components?: unknown };
  assert.deepEqual(sent.components, [
    { type: 10, content: "Something needs attention on deck" },
  ]);
});

test("a missing checklist file leaves the standing instructions out of the prompt", async () => {
  env.HEARTBEAT_CHECKLIST_PATH = "/nonexistent/HEARTBEAT.md";
  await addChannel("chan-a", null);
  const channel = makeChannel();
  const client = makeClient(async () => channel);
  turn.handleConversationTurn.mockResolvedValue(turnResult("HEARTBEAT_OK"));

  heartbeat.startHeartbeat(client);
  await waitFor(
    () => turn.handleConversationTurn.mock.calls.length > 0,
    "the turn to run"
  );

  const params = turn.handleConversationTurn.mock.calls[0]?.[0];
  assert.doesNotMatch(params.content, /standing instructions/);
  assert.match(params.content, /\[HEARTBEAT CHECK\]/);
});

test("HEARTBEAT_OK with at most ackMaxChars of extra text is suppressed", async () => {
  await addChannel("chan-a", "guild-1");
  const channel = makeChannel();
  const client = makeClient(async () => channel);
  // remainder after stripping the marker is well under 40 chars
  turn.handleConversationTurn.mockResolvedValue(
    turnResult("All quiet on deck. HEARTBEAT_OK")
  );

  heartbeat.startHeartbeat(client);
  await waitFor(
    () => turn.handleConversationTurn.mock.calls.length > 0,
    "the turn to run"
  );
  await flush();

  assert.equal(channel.send.mock.calls.length, 0);
});

test("HEARTBEAT_OK buried in a long report still gets posted", async () => {
  await addChannel("chan-a", "guild-1");
  const channel = makeChannel();
  const client = makeClient(async () => channel);
  const longReport = `HEARTBEAT_OK but actually ${"x".repeat(60)}`;
  turn.handleConversationTurn.mockResolvedValue(turnResult(longReport));

  heartbeat.startHeartbeat(client);
  await waitFor(() => channel.send.mock.calls.length > 0, "the alert to send");

  assert.equal(channel.send.mock.calls.length, 1);
});

test("a DM target is labelled 'DM' with no guild and falls back to a system user", async () => {
  await addChannel("dm-1", null);
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
  turn.handleConversationTurn.mockResolvedValue(turnResult("Take a look"));

  heartbeat.startHeartbeat(client);
  await waitFor(() => channel.send.mock.calls.length > 0, "the alert to send");

  const params = turn.handleConversationTurn.mock.calls[0]?.[0];
  assert.equal(params.userId, "system");
  assert.equal(params.messageContext.channelName, "DM");
  assert.equal(params.messageContext.guildName, null);
  assert.equal(params.messageContext.isDM, true);
});

test("a guild channel with no resolved guild reports a null guild name", async () => {
  await addChannel("chan-a", "guild-1");
  const channel = makeChannel({ guild: null });
  const client = makeClient(async () => channel);
  turn.handleConversationTurn.mockResolvedValue(turnResult("Take a look"));

  heartbeat.startHeartbeat(client);
  await waitFor(() => channel.send.mock.calls.length > 0, "the alert to send");

  const params = turn.handleConversationTurn.mock.calls[0]?.[0];
  assert.equal(params.messageContext.guildName, null);
});

test("an unsendable channel is skipped without running a turn", async () => {
  await addChannel("chan-a", "guild-1");
  const channel = makeChannel({ isSendable: () => false });
  const client = makeClient(async () => channel);

  heartbeat.startHeartbeat(client);
  await waitFor(
    () => client.channels.fetch.mock.calls.length > 0,
    "the channel fetch"
  );
  await flush();

  assert.equal(turn.handleConversationTurn.mock.calls.length, 0);
});

test("one failing channel does not block the others", async () => {
  await addChannel("chan-bad", "guild-1");
  await addChannel("chan-good", "guild-1");
  const channel = makeChannel();
  const client = makeClient(async (id: string) => {
    if (id === "chan-bad") throw new Error("boom");
    return channel;
  });
  turn.handleConversationTurn.mockResolvedValue(turnResult("HEARTBEAT_OK"));

  heartbeat.startHeartbeat(client);
  await waitFor(
    () => turn.handleConversationTurn.mock.calls.length > 0,
    "the surviving channel's turn"
  );

  assert.equal(turn.handleConversationTurn.mock.calls.length, 1);
  assert.equal(
    turn.handleConversationTurn.mock.calls[0]?.[0].channelId,
    "chan-good"
  );
});

test("an error thrown inside a tick is swallowed, keeping the loop alive", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  // an unknown IANA zone makes the quiet-hours check throw before any channel
  // work happens — the tick must absorb it rather than reject
  env.HEARTBEAT_TIMEZONE = "Nowhere/Atlantis";
  await addChannel("chan-a", "guild-1");
  const channel = makeChannel();
  const client = makeClient(async () => channel);

  heartbeat.startHeartbeat(client);
  await flush();

  assert.equal(client.channels.fetch.mock.calls.length, 0);
  assert.equal(turn.handleConversationTurn.mock.calls.length, 0);

  // the interval outlived the failed tick: the next one runs normally
  env.HEARTBEAT_TIMEZONE = "UTC";
  turn.handleConversationTurn.mockResolvedValue(turnResult("HEARTBEAT_OK"));
  vi.advanceTimersByTime(env.HEARTBEAT_INTERVAL_MINUTES * 60 * 1000);
  await waitFor(
    () => turn.handleConversationTurn.mock.calls.length === 1,
    "the recovering tick"
  );
});

test("a second start is a no-op and the interval keeps ticking until stopped", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  await addChannel("chan-a", "guild-1");
  const channel = makeChannel();
  const client = makeClient(async () => channel);
  turn.handleConversationTurn.mockResolvedValue(turnResult("HEARTBEAT_OK"));

  heartbeat.startHeartbeat(client);
  await waitFor(
    () => turn.handleConversationTurn.mock.calls.length === 1,
    "the immediate tick"
  );

  // starting again must not fire another immediate tick
  heartbeat.startHeartbeat(client);
  await flush();
  assert.equal(turn.handleConversationTurn.mock.calls.length, 1);

  // advancing one interval fires exactly one more tick
  const intervalMs = env.HEARTBEAT_INTERVAL_MINUTES * 60 * 1000;
  vi.advanceTimersByTime(intervalMs);
  await waitFor(
    () => turn.handleConversationTurn.mock.calls.length === 2,
    "the interval tick"
  );
  await flush();
  assert.equal(turn.handleConversationTurn.mock.calls.length, 2);

  // after stopping, the interval no longer fires
  heartbeat.stopHeartbeat();
  vi.advanceTimersByTime(intervalMs * 2);
  await flush();
  assert.equal(turn.handleConversationTurn.mock.calls.length, 2);
});
