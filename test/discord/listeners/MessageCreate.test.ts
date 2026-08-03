import assert from "node:assert/strict";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { MessageEditOptions } from "discord.js";
import { afterAll, afterEach, beforeEach, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";
import { loaderContext } from "./fixtures.js";

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "skiff-messages-"));

bootstrapTestEnv({ SHELL_WORK_DIR: workDir });

// the conversation turn itself is covered by the ai/llm tests — here it is a
// seam so the listener's Discord plumbing can be exercised in isolation
vi.mock("../../../src/ai/llm/conversation-turn.js", () => ({
  handleConversationTurn: vi.fn(),
}));

const { MessagesListener } = await import(
  "../../../src/discord/listeners/MessageCreate.js"
);
const { handleConversationTurn } = await import(
  "../../../src/ai/llm/conversation-turn.js"
);
const { container, Events } = await import("@sapphire/framework");
const { MessageFlags } = await import("discord.js");
const { env } = await import("../../../src/config/env.js");
const { initAccessConfig } = await import("../../../src/config/access.js");
const { logger } = await import("../../../src/config/logger.js");

initAccessConfig(env);

const BOT_ID = "bot-1";
const turn = vi.mocked(handleConversationTurn);
type TurnParams = Parameters<typeof handleConversationTurn>[0];

const realContainerClient = container.client;
container.client = { user: { id: BOT_ID } } as never;
const listener = new MessagesListener(loaderContext("messageCreate"), {});

// consola would print these; collect them for assertions instead
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
const logs: Array<{ level: LogLevel; args: unknown[] }> = [];
const realLog = new Map<LogLevel, unknown>();
for (const level of LOG_LEVELS) {
  realLog.set(level, logger[level]);
  logger[level] = ((...args: unknown[]) => {
    logs.push({ level, args });
  }) as (typeof logger)[LogLevel];
}
const logged = (level: LogLevel) =>
  logs.filter((entry) => entry.level === level);

const realFetch = globalThis.fetch;

afterAll(async () => {
  for (const level of LOG_LEVELS) {
    logger[level] = realLog.get(level) as (typeof logger)[LogLevel];
  }
  globalThis.fetch = realFetch;
  container.client = realContainerClient;
  await fs.rm(workDir, { recursive: true, force: true });
});

interface FakeAttachment {
  id: string;
  name: string | null;
  url: string;
  contentType: string | null;
  size: number;
}

interface FakeMessageOptions {
  content?: string;
  bot?: boolean;
  isDM?: boolean;
  mentioned?: boolean;
  reference?: boolean;
  fetchReference?: () => Promise<unknown>;
  attachments?: FakeAttachment[];
  member?: { displayName: string } | null;
}

/** A Discord message double: records replies and the messages they produce. */
function fakeMessage(options: FakeMessageOptions = {}) {
  const {
    content = `<@${BOT_ID}> hello there`,
    bot = false,
    isDM = false,
    mentioned = true,
    reference = false,
    fetchReference = async () => ({
      author: { id: BOT_ID },
      content: "earlier answer",
    }),
    attachments = [],
    // DMs have no guild member, so the listener falls back to the user
    member = isDM ? null : { displayName: "Remco of the Guild" },
  } = options;

  const sent: Array<{ edit: ReturnType<typeof vi.fn> }> = [];
  const reply = vi.fn(async (_options?: unknown) => {
    const message = { edit: vi.fn(async () => {}) };
    sent.push(message);
    return message;
  });

  const channel = isDM
    ? { isDMBased: () => true }
    : {
        isDMBased: () => false,
        sendTyping: vi.fn(async () => {}),
        name: "general",
      };

  return {
    id: "message-1",
    content,
    author: {
      id: "user-1",
      bot,
      username: "remco",
      displayName: "Remco",
    },
    member,
    mentions: { has: () => mentioned },
    channel,
    channelId: isDM ? "dm-1" : "channel-1",
    guildId: isDM ? null : "guild-1",
    guild: isDM ? null : { name: "Skiff HQ" },
    // keyed by index so a test can hand in two attachments with the same id
    attachments: new Map(attachments.map((att, i) => [`${i}`, att])),
    reference: reference ? { messageId: "message-0" } : null,
    fetchReference: vi.fn(fetchReference),
    reply,
    sent,
  };
}

type FakeMessage = ReturnType<typeof fakeMessage>;

function run(message: FakeMessage) {
  return listener.run(message as never);
}

function lastParams(): TurnParams {
  const call = turn.mock.calls.at(-1);
  assert.ok(call, "handleConversationTurn was never called");
  return call[0];
}

function attachment(overrides: Partial<FakeAttachment> = {}): FakeAttachment {
  return {
    id: "att-1",
    name: "photo.png",
    url: "https://cdn.example/photo.png",
    contentType: "image/png",
    size: 3,
    ...overrides,
  };
}

beforeEach(() => {
  logs.length = 0;
  turn.mockReset();
  turn.mockResolvedValue({
    messages: [{ components: ["answer"], files: [] }],
    historyLength: 3,
  } as never);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("listens for message creation", () => {
  assert.equal(listener.event, Events.MessageCreate);
});

test("ignores messages from other bots", async () => {
  const message = fakeMessage({ bot: true });
  await run(message);

  assert.equal(turn.mock.calls.length, 0);
  assert.equal(message.reply.mock.calls.length, 0);
});

test("ignores messages until the client's own user is known", async () => {
  const realClient = container.client;
  container.client = { user: null } as never;
  try {
    await run(fakeMessage());
  } finally {
    container.client = realClient;
  }

  assert.equal(turn.mock.calls.length, 0);
});

test("ignores guild chatter that neither mentions nor answers the bot", async () => {
  const message = fakeMessage({ content: "just talking", mentioned: false });
  await run(message);

  assert.equal(turn.mock.calls.length, 0);
  assert.equal(message.reply.mock.calls.length, 0);
});

test("answers a mention with the mention stripped from the content", async () => {
  const message = fakeMessage();
  await run(message);

  const params = lastParams();
  assert.equal(params.content, "hello there");
  assert.equal(params.userId, "user-1");
  assert.equal(params.channelId, "channel-1");
  assert.equal(params.guildId, "guild-1");
  assert.equal(params.images, undefined);
  assert.deepEqual(params.messageContext, {
    displayName: "Remco of the Guild",
    username: "remco",
    channelName: "#general",
    guildName: "Skiff HQ",
    isDM: false,
  });
  assert.equal(params.toolContext?.client, container.client);

  assert.deepEqual(message.reply.mock.calls[0]?.[0], {
    flags: MessageFlags.IsComponentsV2,
    components: ["answer"],
    files: [],
  });
  assert.equal(message.channel.sendTyping?.mock.calls.length, 1);
});

test("answers direct messages without a mention and skips typing", async () => {
  const message = fakeMessage({ content: "hi there", isDM: true });
  await run(message);

  const params = lastParams();
  assert.equal(params.content, "hi there");
  assert.equal(params.guildId, null);
  assert.deepEqual(params.messageContext, {
    displayName: "Remco",
    username: "remco",
    channelName: "DM",
    guildName: null,
    isDM: true,
  });
});

test("answers a reply to the bot and quotes the message replied to", async () => {
  const message = fakeMessage({
    content: "and the second one?",
    mentioned: false,
    reference: true,
  });
  await run(message);

  assert.equal(
    lastParams().content,
    '[Replying to: "earlier answer"]\n\nand the second one?'
  );
});

test("answers a reply to a bot message that carries no text", async () => {
  const message = fakeMessage({
    content: "and the second one?",
    mentioned: false,
    reference: true,
    // components-only bot messages have an empty content field
    fetchReference: async () => ({ author: { id: BOT_ID }, content: "" }),
  });
  await run(message);

  assert.equal(lastParams().content, "and the second one?");
});

test("ignores a reply to another user's message", async () => {
  const message = fakeMessage({
    content: "not for the bot",
    mentioned: false,
    reference: true,
    fetchReference: async () => ({
      author: { id: "user-2" },
      content: "someone else",
    }),
  });
  await run(message);

  assert.equal(turn.mock.calls.length, 0);
});

test("survives a reference whose message was deleted", async () => {
  const message = fakeMessage({
    content: `<@${BOT_ID}> what did you say?`,
    reference: true,
    fetchReference: async () => {
      throw new Error("Unknown Message");
    },
  });
  await run(message);

  assert.equal(lastParams().content, "what did you say?");
});

test("stays silent when access is denied", async () => {
  initAccessConfig({ ...env, ACCESS_POLICY: "disabled" });
  try {
    await run(fakeMessage());
  } finally {
    initAccessConfig(env);
  }

  assert.equal(turn.mock.calls.length, 0);
  assert.match(String(logged("debug")[0]?.args[0]), /Access denied/);
  assert.equal(
    (logged("debug")[0]?.args[1] as { reason?: string })?.reason,
    "Bot is disabled"
  );
});

test("ignores a bare mention with no content and no attachments", async () => {
  const message = fakeMessage({ content: `<@!${BOT_ID}>` });
  await run(message);

  assert.equal(turn.mock.calls.length, 0);
});

test("downloads attachments, passes images through and cleans up after", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  globalThis.fetch = vi.fn(async () => new Response(bytes)) as typeof fetch;

  const message = fakeMessage({
    content: `<@${BOT_ID}> what is this?`,
    attachments: [
      attachment(),
      attachment({
        id: "att-2",
        name: "notes.txt",
        url: "https://cdn.example/notes.txt",
        contentType: "text/plain",
        size: 0,
      }),
    ],
  });
  await run(message);

  const params = lastParams();
  const expectedPath = path.join(workDir, "attachments", "message-1-att-1.png");
  assert.match(
    params.content,
    new RegExp(
      `\\[Attachment: photo.png → ${expectedPath} \\(image/png, 3 bytes\\)\\]`
    )
  );
  // a zero-size, non-image attachment still gets a path but no size metadata
  assert.match(
    params.content,
    /\[Attachment: notes.txt → .*message-1-att-2\.txt \(text\/plain\)\]/
  );
  assert.match(params.content, /^what is this\?\n\n\[Attachment/);

  assert.equal(params.images?.length, 1);
  assert.equal(params.images?.[0]?.mediaType, "image/png");
  assert.equal(params.images?.[0]?.name, "photo.png");
  assert.deepEqual(new Uint8Array(params.images?.[0]?.data as Buffer), bytes);

  // the files are removed once the turn is done
  for (let i = 0; i < 100 && fsSync.existsSync(expectedPath); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fsSync.existsSync(expectedPath), false);
});

test("names attachments after their stored file when Discord sends none", async () => {
  globalThis.fetch = vi.fn(
    async () => new Response(new Uint8Array([7]))
  ) as typeof fetch;

  const message = fakeMessage({
    content: `<@${BOT_ID}> and these?`,
    attachments: [
      attachment({ id: "att-3", name: null, contentType: null, size: 0 }),
      attachment({ id: "att-4", name: null, size: 0 }),
    ],
  });
  await run(message);

  const params = lastParams();
  // no name, no content type and no size: nothing to put in the metadata
  assert.match(params.content, /\[Attachment: message-1-att-3 → \S+att-3\]\n/);
  assert.match(
    params.content,
    /\[Attachment: message-1-att-4 → \S+att-4 \(image\/png\)\]/
  );
  assert.equal(params.images?.[0]?.name, "message-1-att-4");
});

test("shrugs off a cleanup failure for an already-removed file", async () => {
  globalThis.fetch = vi.fn(
    async () => new Response(new Uint8Array([7]))
  ) as typeof fetch;

  // two attachments sharing an id land on the same path, so only the first
  // unlink can succeed — the second must not surface as an error
  const message = fakeMessage({
    content: `<@${BOT_ID}> twice`,
    attachments: [attachment({ id: "dup" }), attachment({ id: "dup" })],
  });
  await run(message);

  assert.equal(lastParams().images?.length, 2);
  const duplicate = path.join(workDir, "attachments", "message-1-dup.png");
  for (let i = 0; i < 100 && fsSync.existsSync(duplicate); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fsSync.existsSync(duplicate), false);
  assert.deepEqual(logged("error"), []);
});

test("falls back to the attachment url when the download fails", async () => {
  globalThis.fetch = vi.fn(
    async () => new Response("nope", { status: 404 })
  ) as typeof fetch;

  const message = fakeMessage({
    content: `<@${BOT_ID}>`,
    attachments: [attachment({ name: null })],
  });
  await run(message);

  // no text of its own: the attachment block becomes the whole content
  assert.equal(
    lastParams().content,
    "[Attachment: unknown — download failed, available at: https://cdn.example/photo.png]"
  );
  assert.match(String(logged("warn")[0]?.args[0]), /Failed to download/);
});

test("streams tool status into a reply and then edits it", async () => {
  turn.mockImplementation((async (params: TurnParams) => {
    params.onToolStatus?.("Running bash");
    await new Promise((resolve) => setTimeout(resolve, 10));
    params.onToolStatus?.("Reading files");
    return {
      messages: [{ components: ["final"], files: [] }],
      historyLength: 7,
    };
  }) as never);

  const message = fakeMessage();
  await run(message);

  // one reply carrying the first status, no second reply for the answer
  assert.equal(message.reply.mock.calls.length, 1);
  const status = message.sent[0];
  assert.ok(status);
  assert.equal(status.edit.mock.calls.length, 2);
  assert.deepEqual(status.edit.mock.calls[1]?.[0], {
    flags: MessageFlags.IsComponentsV2,
    components: ["final"],
    files: [],
  });
  assert.match(
    String(logged("info").at(-1)?.args[0]),
    /convo length so far: 7 messages/
  );
});

test("reports a failure to publish a tool status without failing the turn", async () => {
  turn.mockImplementation((async (params: TurnParams) => {
    params.onToolStatus?.("Running bash");
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      messages: [{ components: ["final"], files: [] }],
      historyLength: 1,
    };
  }) as never);

  const message = fakeMessage();
  message.reply.mockRejectedValueOnce(new Error("Missing permissions"));
  await run(message);

  assert.match(
    String(logged("warn")[0]?.args[0]),
    /Failed to update tool status/
  );
  // the answer still goes out as a fresh reply
  assert.deepEqual(message.reply.mock.calls.at(-1)?.[0], {
    flags: MessageFlags.IsComponentsV2,
    components: ["final"],
    files: [],
  });
});

test("lets tools reuse the status message through editStatusMessage", async () => {
  const returned: unknown[] = [];
  turn.mockImplementation((async (params: TurnParams) => {
    returned.push(
      await params.toolContext?.editStatusMessage?.({ content: "working" })
    );
    returned.push(
      await params.toolContext?.editStatusMessage?.({
        content: "still working",
        components: [],
      })
    );
    return { messages: [], historyLength: 2 };
  }) as never);

  const message = fakeMessage();
  await run(message);

  // both calls resolve to the same status message: created once, then edited
  assert.equal(returned[0], message.sent[0]);
  assert.equal(returned[1], message.sent[0]);
  assert.deepEqual(message.reply.mock.calls[0]?.[0], {
    content: "working",
    components: undefined,
  });
  assert.equal(message.sent[0]?.edit.mock.calls.length, 1);
  // no messages came back from the turn
  assert.equal(message.reply.mock.calls.at(-1)?.[0], "I had nothing to say.");
});

test("waits for an in-flight status reply before a tool edits it", async () => {
  const returned: unknown[] = [];
  turn.mockImplementation((async (params: TurnParams) => {
    // the status reply is still in flight when the tool asks to edit it
    params.onToolStatus?.("Running bash");
    returned.push(
      await params.toolContext?.editStatusMessage?.({ content: "done" })
    );
    return {
      messages: [{ components: ["final"], files: [] }],
      historyLength: 1,
    };
  }) as never);

  const message = fakeMessage();
  await run(message);

  // exactly one status message was created, then edited rather than re-sent
  assert.equal(message.reply.mock.calls.length, 1);
  assert.equal(returned[0], message.sent[0]);
  assert.equal(message.sent[0]?.edit.mock.calls.length, 2);
});

test("creates the status message from components alone", async () => {
  turn.mockImplementation((async (params: TurnParams) => {
    await params.toolContext?.editStatusMessage?.({
      components: ["progress"],
    } as unknown as MessageEditOptions);
    return {
      messages: [{ components: ["final"], files: [] }],
      historyLength: 1,
    };
  }) as never);

  const message = fakeMessage();
  await run(message);

  assert.deepEqual(message.reply.mock.calls[0]?.[0], {
    content: undefined,
    components: ["progress"],
  });
});

test("returns null when the status message cannot be edited", async () => {
  const returned: unknown[] = [];
  turn.mockImplementation((async (params: TurnParams) => {
    returned.push(
      await params.toolContext?.editStatusMessage?.({ content: "working" })
    );
    return {
      messages: [{ components: ["final"], files: [] }],
      historyLength: 1,
    };
  }) as never);

  const message = fakeMessage();
  message.reply.mockRejectedValueOnce(new Error("Missing permissions"));
  await run(message);

  assert.equal(returned[0], null);
  assert.match(
    String(logged("warn")[0]?.args[0]),
    /Failed to edit status message/
  );
});

test("sends every chunk of a long answer", async () => {
  turn.mockResolvedValue({
    messages: [
      { components: ["part-1"], files: [] },
      { components: ["part-2"], files: ["file.txt"] },
      { components: ["part-3"], files: [] },
    ],
    historyLength: 4,
  } as never);

  const message = fakeMessage();
  await run(message);

  assert.deepEqual(
    message.reply.mock.calls.map((call) => call[0]),
    [
      { flags: MessageFlags.IsComponentsV2, components: ["part-1"], files: [] },
      {
        flags: MessageFlags.IsComponentsV2,
        components: ["part-2"],
        files: ["file.txt"],
      },
      { flags: MessageFlags.IsComponentsV2, components: ["part-3"], files: [] },
    ]
  );
});

test("apologises when the turn throws", async () => {
  turn.mockRejectedValue(new Error("model unavailable"));

  const message = fakeMessage();
  await run(message);

  assert.match(String(logged("error")[0]?.args[0]), /chat failed/);
  assert.equal(
    message.reply.mock.calls[0]?.[0],
    "Something went wrong — try again in a moment."
  );
});
