import assert from "node:assert/strict";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { Client } from "discord.js";
import { beforeAll, beforeEach, test, vi } from "vitest";
import { bootstrapTestEnv, MISSING_MCP_CONFIG } from "../../helpers/setup.js";

// The turn orchestrates real modules (db, markdown rendering, citations) but
// three of its collaborators reach for the network: `chat`, `compactConversation`
// (its own LLM call) and `enqueueMemoryExtraction` (a timer that later calls the
// LLM). Those are replaced; `shouldCompact` and everything else stays real.
const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  compactConversation: vi.fn(),
  enqueueEmbedding: vi.fn(),
  enqueueMemoryExtraction: vi.fn(),
  findRelevantStorylines: vi.fn(),
}));

vi.mock("../../../src/ai/llm/streaming.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/ai/llm/streaming.js")>();
  return { ...actual, chat: mocks.chat };
});
vi.mock("../../../src/ai/memory/compaction.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/ai/memory/compaction.js")
    >();
  return { ...actual, compactConversation: mocks.compactConversation };
});
vi.mock("../../../src/ai/memory/embeddings.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../src/ai/memory/embeddings.js")
    >();
  return { ...actual, enqueueEmbedding: mocks.enqueueEmbedding };
});
vi.mock("../../../src/ai/memory/extract.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/ai/memory/extract.js")>();
  return { ...actual, enqueueMemoryExtraction: mocks.enqueueMemoryExtraction };
});
vi.mock("../../../src/ai/logbook/store.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/ai/logbook/store.js")>();
  return { ...actual, findRelevantStorylines: mocks.findRelevantStorylines };
});

bootstrapTestEnv();
process.env.MCP_CONFIG_PATH = MISSING_MCP_CONFIG;
process.env.LLM_DEFAULT_MODEL = "gpt-4o-mini";

type Streaming = typeof import("../../../src/ai/llm/streaming.js");
type Queries = typeof import("../../../src/db/queries.js");
type ConversationTurn =
  typeof import("../../../src/ai/llm/conversation-turn.js");

let handleConversationTurn: ConversationTurn["handleConversationTurn"];
let ContextWindowFullError: Streaming["ContextWindowFullError"];
let queries: Queries;
let env: typeof import("../../../src/config/env.js").env;
let container: typeof import("@sapphire/framework").container;

beforeAll(async () => {
  const { runMigrations } = await import("../../../src/db/migrate.js");
  await runMigrations();
  ({ handleConversationTurn } = await import(
    "../../../src/ai/llm/conversation-turn.js"
  ));
  ({ ContextWindowFullError } = await import(
    "../../../src/ai/llm/streaming.js"
  ));
  queries = await import("../../../src/db/queries.js");
  ({ env } = await import("../../../src/config/env.js"));
  ({ container } = await import("@sapphire/framework"));
});

// fixtures

const usage = {
  inputTokens: 10,
  inputTokenDetails: {
    noCacheTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 5,
  outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
  totalTokens: 15,
};

type ChatResult = Awaited<ReturnType<Streaming["chat"]>>;
type ChatContext = Parameters<Streaming["chat"]>[0];

function chatResult(over: Partial<ChatResult> = {}): ChatResult {
  const text = over.text ?? "ok";
  return {
    text,
    responseMessages: [{ id: "a1", role: "assistant", content: text }],
    usage,
    lastInputTokens: 100,
    finishReason: "stop",
    stepCount: 1,
    attachments: [],
    ...over,
  } as ChatResult;
}

/** Resolve `chat` with a canned result. */
function mockChat(over: Partial<ChatResult> = {}): void {
  mocks.chat.mockResolvedValue(chatResult(over));
}

let channelCounter = 0;
function params(
  over: Partial<Parameters<typeof handleConversationTurn>[0]> = {}
) {
  const channelId = over.channelId ?? `chan-${++channelCounter}`;
  const guildId = over.guildId === undefined ? "guild-1" : over.guildId;
  return {
    content: "hello there",
    userId: "user-1",
    channelId,
    guildId,
    skipMemory: true,
    skipInitialStatus: true,
    toolContext: {
      client: {} as Client,
      guildId,
      channelId,
      userId: "user-1",
    },
    messageContext: {
      displayName: "Remco",
      username: "remco",
      channelName: "#general",
      guildName: "Guild",
      isDM: false,
    },
    ...over,
  };
}

const lastChatContext = (): ChatContext =>
  mocks.chat.mock.calls.at(-1)?.[0] as ChatContext;

const rendered = (messages: Array<{ components: unknown[] }>) =>
  JSON.stringify(messages);

/** Install a fake sapphire command store so `clearMention` can resolve. */
function stubCommandStore(command: unknown): void {
  (container as unknown as { stores: unknown }).stores = {
    get: () => ({ get: () => command }),
  };
}

function clearCommand(guildIds: Map<string, Set<string>>, global: Set<string>) {
  return {
    applicationCommandRegistry: {
      guildIdToChatInputCommandIds: guildIds,
      globalChatInputCommandIds: global,
    },
  };
}

beforeEach(() => {
  mocks.chat.mockReset();
  mocks.compactConversation.mockReset().mockResolvedValue(false);
  mocks.enqueueEmbedding.mockReset().mockResolvedValue(false);
  mocks.enqueueMemoryExtraction.mockReset().mockReturnValue(false);
  mocks.findRelevantStorylines.mockReset().mockResolvedValue([]);
  stubCommandStore(undefined);
});

// happy path & persistence

test("persists the user message and the assistant reply", async () => {
  mockChat({ text: "the answer" });
  const p = params({ channelId: "chan-basic" });

  const result = await handleConversationTurn(p);

  assert.equal(result.text, "the answer");
  assert.equal(result.usedTools, false);
  // user turn + assistant reply, on top of an empty history
  assert.equal(result.historyLength, 2);
  assert.ok(rendered(result.messages).includes("the answer"));

  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-basic",
    guildId: "guild-1",
  });
  const rows = await queries.getRecentMessages(conversation.id);
  assert.deepEqual(
    rows.map((r) => [r.role, r.content]),
    [
      ["user", "hello there"],
      ["assistant", "the answer"],
    ]
  );

  // the persisted user row is handed to tools as provenance
  assert.ok(typeof p.toolContext.sourceMessageId === "number");
});

test("the newest message carries a sender block ahead of the user's text", async () => {
  mockChat();
  await handleConversationTurn(params({ content: "who am I?" }));

  const sent = lastChatContext().messages.at(-1) as ModelMessage;
  assert.equal(sent.role, "user");
  assert.equal(typeof sent.content, "string");
  const text = sent.content as string;
  assert.match(text, /"display_name":"Remco"/);
  assert.match(text, /"username":"remco"/);
  assert.match(text, /"user_id":"user-1"/);
  assert.ok(text.endsWith("\nwho am I?"));
});

test("a per-turn model override wins over the channel selection", async () => {
  mockChat();
  await queries.setConversationModelOverride({
    channelId: "chan-model",
    guildId: "guild-1",
    model: "gpt-4o",
  });

  await handleConversationTurn(
    params({ channelId: "chan-model", modelOverride: "gpt-4.1" })
  );
  assert.equal(
    (lastChatContext().model as { modelId: string }).modelId,
    "gpt-4.1"
  );

  // without the per-turn override the channel's selection is used
  await handleConversationTurn(params({ channelId: "chan-model" }));
  assert.equal(
    (lastChatContext().model as { modelId: string }).modelId,
    "gpt-4o"
  );
});

test("prior history is replayed with its tool calls and results intact", async () => {
  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-history",
    guildId: "guild-1",
  });
  await queries.insertMessage({
    conversationId: conversation.id,
    role: "user",
    content: "search for it",
  });
  await queries.insertMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: null,
    toolCalls: [
      {
        type: "tool-call",
        toolCallId: "c1",
        toolName: "web_search",
        input: { query: "it" },
      },
    ],
  });
  await queries.insertMessage({
    conversationId: conversation.id,
    role: "tool",
    content: null,
    toolResults: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "web_search",
        output: { type: "json", value: { hits: 1 } },
      },
    ],
  });
  await queries.insertMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: "found it",
    toolCalls: [
      {
        type: "tool-call",
        toolCallId: "c2",
        toolName: "fetch_url",
        input: { url: "https://example.com" },
      },
    ],
  });

  mockChat();
  await handleConversationTurn(params({ channelId: "chan-history" }));

  const sent = lastChatContext().messages;
  // 4 history rows + the current message
  assert.equal(sent.length, 5);
  assert.deepEqual(sent[0], { role: "user", content: "search for it" });
  // a tool-call row with no text yields parts without a leading text part
  assert.equal(sent[1]?.role, "assistant");
  assert.equal((sent[1]?.content as unknown[]).length, 1);
  assert.equal(sent[2]?.role, "tool");
  assert.equal((sent[2]?.content as unknown[]).length, 1);
  // a row with both text and calls keeps the text first
  const both = sent[3]?.content as Array<{ type: string }>;
  assert.equal(both.length, 2);
  assert.equal(both[0]?.type, "text");
  assert.equal(both[1]?.type, "tool-call");
});

test("a tool row whose results were never stored replays as an empty list", async () => {
  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-empty-tool",
    guildId: "guild-1",
  });
  await queries.insertMessage({
    conversationId: conversation.id,
    role: "user",
    content: "hi",
  });
  // content is required for the row to survive getRecentMessages' filter
  await queries.insertMessage({
    conversationId: conversation.id,
    role: "tool",
    content: "orphan",
  });

  mockChat();
  await handleConversationTurn(params({ channelId: "chan-empty-tool" }));

  const sent = lastChatContext().messages;
  assert.deepEqual(sent[1], { role: "tool", content: [] });
});

test("an assistant row with results but no text replays as empty content", async () => {
  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-nocontent",
    guildId: "guild-1",
  });
  await queries.insertMessage({
    conversationId: conversation.id,
    role: "assistant",
    content: null,
    toolResults: [
      {
        type: "tool-result",
        toolCallId: "c1",
        toolName: "web_search",
        output: { type: "json", value: {} },
      },
    ],
  });

  mockChat();
  await handleConversationTurn(params({ channelId: "chan-nocontent" }));

  const sent = lastChatContext().messages;
  assert.deepEqual(sent[0], { role: "assistant", content: "" });
});

test("assistant content parts and tool results are persisted separately", async () => {
  mockChat({
    text: "done",
    responseMessages: [
      {
        id: "m1",
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "web_search",
            input: { query: "x" },
          },
        ],
      },
      {
        id: "m2",
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "web_search",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
      { id: "m3", role: "assistant", content: "done" },
    ],
  } as Partial<ChatResult>);

  await handleConversationTurn(params({ channelId: "chan-parts" }));

  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-parts",
    guildId: "guild-1",
  });
  const rows = await queries.getRecentMessages(conversation.id);
  assert.deepEqual(
    rows.map((r) => r.role),
    ["user", "assistant", "tool", "assistant"]
  );
  assert.equal(rows[1]?.content, "checking");
  assert.equal(rows[1]?.toolCalls?.length, 1);
  assert.equal(rows[2]?.toolResults?.length, 1);
  assert.equal(rows[3]?.content, "done");
});

test("an assistant message of tool calls only persists with null text", async () => {
  mockChat({
    text: "",
    responseMessages: [
      {
        id: "m1",
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "web_search",
            input: { query: "x" },
          },
        ],
      },
    ],
  } as Partial<ChatResult>);

  await handleConversationTurn(params({ channelId: "chan-callsonly" }));

  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-callsonly",
    guildId: "guild-1",
  });
  const rows = await queries.getRecentMessages(conversation.id);
  assert.equal(rows[1]?.content, null);
  assert.equal(rows[1]?.toolCalls?.length, 1);
});

test("empty assistant text is stored as null rather than an empty string", async () => {
  mockChat({
    text: "",
    responseMessages: [
      { id: "m1", role: "assistant", content: "" },
      { id: "m2", role: "assistant", content: [{ type: "text", text: "hi" }] },
    ],
  } as Partial<ChatResult>);

  await handleConversationTurn(params({ channelId: "chan-empty-text" }));

  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-empty-text",
    guildId: "guild-1",
  });
  const rows = await queries.getRecentMessages(conversation.id);
  // the empty row carries nothing, so getRecentMessages filters it out entirely
  assert.deepEqual(
    rows.map((r) => [r.role, r.content, r.toolCalls]),
    [
      ["user", "hello there", null],
      // a text-only parts array persists as plain text with no tool calls
      ["assistant", "hi", null],
    ]
  );
});

test("a reply with no response messages still persists the final text", async () => {
  mockChat({ text: "salvaged", responseMessages: [] });

  await handleConversationTurn(params({ channelId: "chan-fallback" }));

  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-fallback",
    guildId: "guild-1",
  });
  const rows = await queries.getRecentMessages(conversation.id);
  assert.deepEqual(
    rows.map((r) => [r.role, r.content]),
    [
      ["user", "hello there"],
      ["assistant", "salvaged"],
    ]
  );
});

// vision

test("images ride along as vision parts when vision is enabled", async () => {
  mockChat();
  await handleConversationTurn(
    params({
      images: [
        { mediaType: "image/png", data: Buffer.from("png"), name: "a.png" },
      ],
    })
  );

  const sent = lastChatContext().messages.at(-1) as ModelMessage;
  const parts = sent.content as Array<{ type: string; mediaType?: string }>;
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.type, "text");
  assert.equal(parts[1]?.type, "image");
  assert.equal(parts[1]?.mediaType, "image/png");
});

test("images are dropped when vision is disabled", async () => {
  const saved = env.VISION_ENABLED;
  env.VISION_ENABLED = false;
  try {
    mockChat();
    await handleConversationTurn(
      params({
        images: [
          { mediaType: "image/png", data: Buffer.from("png"), name: "a.png" },
        ],
      })
    );
    const sent = lastChatContext().messages.at(-1) as ModelMessage;
    assert.equal(typeof sent.content, "string");
  } finally {
    env.VISION_ENABLED = saved;
  }
});

test("an empty image list is treated as no images", async () => {
  mockChat();
  await handleConversationTurn(params({ images: [] }));
  const sent = lastChatContext().messages.at(-1) as ModelMessage;
  assert.equal(typeof sent.content, "string");
});

// status updates

test("an immediate thinking indicator is shown unless the caller has one", async () => {
  mockChat();
  const statuses: string[] = [];
  await handleConversationTurn(
    params({
      skipInitialStatus: false,
      onToolStatus: (s) => statuses.push(s),
    })
  );
  assert.equal(statuses.length, 1);

  statuses.length = 0;
  await handleConversationTurn(
    params({ skipInitialStatus: true, onToolStatus: (s) => statuses.push(s) })
  );
  assert.equal(statuses.length, 0);
});

test("rapid tool activity collapses into one debounced status update", async () => {
  mocks.chat.mockImplementation(async (ctx: ChatContext) => {
    // two events in quick succession: the second must cancel the first's
    // pending update rather than producing two edits
    ctx.onToolActivity?.({
      type: "tool",
      stepNumber: 0,
      toolName: "web_search",
      args: {},
      output: null,
    });
    ctx.onToolActivity?.({
      type: "tool",
      stepNumber: 1,
      toolName: "fetch_url",
      args: {},
      output: null,
    });
    // outlive the 800ms debounce so the pending update actually fires
    await new Promise((resolve) => setTimeout(resolve, 950));
    return chatResult({ text: "searched" });
  });

  const statuses: string[] = [];
  const result = await handleConversationTurn(
    params({ skipInitialStatus: false, onToolStatus: (s) => statuses.push(s) })
  );

  // the initial "thinking" line plus exactly one debounced update
  assert.equal(statuses.length, 2);
  assert.match(statuses[1] ?? "", /Searching the web/);
  assert.match(statuses[1] ?? "", /Fetching web page/);
  assert.equal(result.usedTools, true);
});

test("a pending status update is cancelled when the turn fails outright", async () => {
  mocks.chat.mockImplementation(async (ctx: ChatContext) => {
    ctx.onToolActivity?.({
      type: "tool",
      stepNumber: 0,
      toolName: "web_search",
      args: {},
      output: null,
    });
    throw new Error("provider exploded mid-tool");
  });

  const statuses: string[] = [];
  await assert.rejects(
    () =>
      handleConversationTurn(params({ onToolStatus: (s) => statuses.push(s) })),
    /provider exploded mid-tool/
  );

  // long enough that a surviving debounce timer would have fired
  await new Promise((resolve) => setTimeout(resolve, 950));
  assert.equal(statuses.length, 0);
});

test("tool activity without a status callback is still recorded", async () => {
  mocks.chat.mockImplementation(async (ctx: ChatContext) => {
    ctx.onToolActivity?.({
      type: "tool",
      stepNumber: 0,
      toolName: "web_search",
      args: {},
      output: null,
    });
    ctx.onToolActivity?.({
      type: "reasoning",
      stepNumber: 0,
      tokens: 10,
      estimated: false,
    });
    return chatResult({ text: "searched" });
  });

  const result = await handleConversationTurn(params());
  assert.equal(result.usedTools, true);
});

test("a turn whose only activity is reasoning did not use tools", async () => {
  mocks.chat.mockImplementation(async (ctx: ChatContext) => {
    ctx.onToolActivity?.({
      type: "reasoning",
      stepNumber: 0,
      tokens: 10,
      estimated: true,
    });
    return chatResult({ text: "thought about it" });
  });

  const result = await handleConversationTurn(params());
  assert.equal(result.usedTools, false);
});

// memory & logbook

test("relevant storylines are retrieved and passed to the model", async () => {
  mocks.findRelevantStorylines.mockResolvedValue([
    {
      id: 7,
      title: "Ship it",
      status: "active",
      goal: "release",
      currentState: "in review",
    },
  ]);
  mockChat();

  await handleConversationTurn(params({ skipMemory: false }));

  assert.deepEqual(lastChatContext().logbookContext, [
    "#7 Ship it [active] — Goal: release Current state: in review",
  ]);
});

test("a failing storyline lookup does not fail the turn", async () => {
  mocks.findRelevantStorylines.mockRejectedValue(new Error("db down"));
  mockChat({ text: "still fine" });

  const result = await handleConversationTurn(params({ skipMemory: false }));

  assert.equal(result.text, "still fine");
  assert.deepEqual(lastChatContext().logbookContext, []);
});

test("memory work receives the citation-stripped body", async () => {
  mockChat({
    text: "Opened in 1932.¹\n\n¹ [History](https://example.com/h)",
  });

  await handleConversationTurn(params({ skipMemory: false }));

  // user message, then the assistant reply
  assert.equal(mocks.enqueueEmbedding.mock.calls.length, 2);
  assert.equal(
    mocks.enqueueEmbedding.mock.calls[0]?.[0]?.content,
    "hello there"
  );
  assert.equal(
    mocks.enqueueEmbedding.mock.calls[1]?.[0]?.content,
    "Opened in 1932.¹"
  );
  const extraction = mocks.enqueueMemoryExtraction.mock.calls[0]?.[0];
  assert.equal(extraction?.userText, "hello there");
  assert.equal(extraction?.assistantText, "Opened in 1932.¹");
});

test("skipMemory suppresses retrieval, embeddings and fact extraction", async () => {
  mockChat();
  await handleConversationTurn(params({ skipMemory: true }));

  assert.equal(mocks.findRelevantStorylines.mock.calls.length, 0);
  assert.equal(mocks.enqueueEmbedding.mock.calls.length, 0);
  assert.equal(mocks.enqueueMemoryExtraction.mock.calls.length, 0);
  assert.deepEqual(lastChatContext().logbookContext, []);
});

// context window exhaustion

test("an unrelated error propagates untouched", async () => {
  mocks.chat.mockRejectedValue(new Error("provider exploded"));
  await assert.rejects(
    () => handleConversationTurn(params()),
    /provider exploded/
  );
});

test("an unsafe-to-retry overflow explains itself instead of repeating tools", async () => {
  mocks.chat.mockImplementation(async (ctx: ChatContext) => {
    ctx.onToolActivity?.({
      type: "tool",
      stepNumber: 0,
      toolName: "send_message",
      args: {},
      output: null,
    });
    throw new ContextWindowFullError(190_000, 200_000, false);
  });

  const result = await handleConversationTurn(
    params({ onToolStatus: () => {} })
  );

  assert.match(result.text, /completed part of the requested work/);
  assert.match(result.text, /`\/clear`/);
  // tool activity from the aborted turn is still reported
  assert.equal(result.usedTools, true);
  assert.equal(result.historyLength, 1);
  assert.equal(mocks.compactConversation.mock.calls.length, 0);
});

test("a safe overflow compacts and retries once", async () => {
  const conversation = await queries.getOrCreateConversation({
    channelId: "chan-recover",
    guildId: "guild-1",
  });
  await queries.insertMessage({
    conversationId: conversation.id,
    role: "user",
    content: "old",
  });

  mocks.compactConversation.mockResolvedValue(true);
  mocks.chat
    .mockRejectedValueOnce(new ContextWindowFullError(190_000, 200_000))
    .mockResolvedValueOnce(chatResult({ text: "recovered" }));

  const result = await handleConversationTurn(
    params({ channelId: "chan-recover" })
  );

  assert.equal(result.text, "recovered");
  assert.equal(mocks.chat.mock.calls.length, 2);
  // the retry runs with a fresh history and no stale token estimate
  assert.equal(lastChatContext().priorInputTokens, null);
});

test("a safe overflow with nothing left to compact gives up cleanly", async () => {
  mocks.compactConversation.mockResolvedValue(false);
  mocks.chat.mockImplementation(async (ctx: ChatContext) => {
    ctx.onToolActivity?.({
      type: "tool",
      stepNumber: 0,
      toolName: "web_search",
      args: {},
      output: null,
    });
    throw new ContextWindowFullError(190_000, 200_000);
  });

  const statuses: string[] = [];
  const result = await handleConversationTurn(
    params({ onToolStatus: (s) => statuses.push(s) })
  );

  assert.match(result.text, /too long for me to continue/);
  // the give-up notice replaces the turn, so it reports no tool use
  assert.equal(result.usedTools, false);
  assert.equal(mocks.chat.mock.calls.length, 1);

  // the pending status edit must not fire on top of the notice
  await new Promise((resolve) => setTimeout(resolve, 950));
  assert.equal(statuses.length, 0);
});

test("an overflow that survives compaction gives up rather than looping", async () => {
  mocks.compactConversation.mockResolvedValue(true);
  mocks.chat.mockRejectedValue(new ContextWindowFullError(190_000, 200_000));

  const result = await handleConversationTurn(params());

  assert.match(result.text, /too long for me to continue/);
  assert.equal(mocks.chat.mock.calls.length, 2);
});

test("a non-overflow failure during the retry still propagates", async () => {
  mocks.compactConversation.mockResolvedValue(true);
  mocks.chat
    .mockRejectedValueOnce(new ContextWindowFullError(190_000, 200_000))
    .mockRejectedValueOnce(new Error("retry exploded"));

  await assert.rejects(
    () => handleConversationTurn(params()),
    /retry exploded/
  );
});

// /clear mention resolution

test("the notice links the guild's registered clear command", async () => {
  stubCommandStore(
    clearCommand(new Map([["guild-1", new Set(["111"])]]), new Set(["999"]))
  );
  mocks.chat.mockRejectedValue(
    new ContextWindowFullError(190_000, 200_000, false)
  );

  const result = await handleConversationTurn(params());
  assert.match(result.text, /<\/clear:111>/);
});

test("a DM falls back to the globally registered clear command", async () => {
  stubCommandStore(
    clearCommand(new Map([["guild-1", new Set(["111"])]]), new Set(["999"]))
  );
  mocks.chat.mockRejectedValue(
    new ContextWindowFullError(190_000, 200_000, false)
  );

  const result = await handleConversationTurn(params({ guildId: null }));
  assert.match(result.text, /<\/clear:999>/);
});

test("an unregistered clear command degrades to plain text", async () => {
  stubCommandStore(clearCommand(new Map(), new Set()));
  mocks.chat.mockRejectedValue(
    new ContextWindowFullError(190_000, 200_000, false)
  );

  const result = await handleConversationTurn(params());
  assert.match(result.text, /`\/clear`/);
});

// footer

test("the footer collects the tool summary, sources and context warning", async () => {
  mocks.chat.mockImplementation(async (ctx: ChatContext) => {
    ctx.onToolActivity?.({
      type: "tool",
      stepNumber: 0,
      toolName: "web_search",
      args: {},
      output: null,
    });
    return chatResult({
      text: "Short answer.¹\n\n¹ [Source one](https://example.com/one)",
      // 80% of the default 200k window trips the memory warning
      lastInputTokens: 160_000,
    });
  });

  const result = await handleConversationTurn(params());

  // everything fits alongside the short body
  assert.equal(result.messages.length, 1);
  const out = rendered(result.messages);
  assert.ok(out.includes("Used 1 tool"));
  assert.ok(out.includes("Sources:"));
  assert.ok(out.includes("Source one"));
  assert.ok(out.includes("Memory 80% full"));
});

test("a footer that would overflow the last chunk is sent separately", async () => {
  const body = "a".repeat(3990);
  mocks.chat.mockImplementation(async (ctx: ChatContext) => {
    ctx.onToolActivity?.({
      type: "tool",
      stepNumber: 0,
      toolName: "web_search",
      args: {},
      output: null,
    });
    return chatResult({ text: body });
  });

  const result = await handleConversationTurn(params());

  assert.equal(result.messages.length, 2);
  assert.ok(rendered(result.messages.slice(0, 1)).includes("aaa"));
  assert.ok(rendered(result.messages.slice(1)).includes("Used 1 tool"));
});

test("a footer too large for one message is emitted as several chunks", async () => {
  const { toSuperscript } = await import("../../../src/ai/llm/citations.js");
  // twenty maximally-long source titles push the footer past Discord's
  // 4000-character ceiling on its own
  const lines = Array.from(
    { length: 20 },
    (_, i) =>
      `${toSuperscript(i + 1)} [${"t".repeat(200)}](https://example.com/${i})`
  );
  mockChat({ text: `Answer.\n\n${lines.join("\n")}` });

  const result = await handleConversationTurn(params());

  assert.ok(result.messages.length >= 3);
  assert.equal(result.text, "Answer.");
  const out = rendered(result.messages);
  assert.ok(out.includes("Sources:"));
  assert.ok(out.includes("https://example.com/19"));
});

test("a plain reply gets no footer at all", async () => {
  mockChat({ text: "just talking", lastInputTokens: 100 });
  const result = await handleConversationTurn(params());
  const out = rendered(result.messages);
  assert.ok(!out.includes("Used "));
  assert.ok(!out.includes("Sources:"));
  assert.ok(!out.includes("Memory "));
});

// attachments

const attachment = (name: string) => ({ name, data: Buffer.from(name) });

test("tool-produced files ride on the final message when there is room", async () => {
  mockChat({
    text: "here you go",
    attachments: [attachment("a.png"), attachment("b.png")],
  } as Partial<ChatResult>);

  const result = await handleConversationTurn(params());

  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.files.length, 2);
});

test("a single overflow attachment gets its own singular trailing chunk", async () => {
  mockChat({
    text: "eleven files",
    attachments: Array.from({ length: 11 }, (_, i) => attachment(`f${i}.png`)),
  } as Partial<ChatResult>);

  const result = await handleConversationTurn(params());

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.files.length, 10);
  assert.equal(result.messages[1]?.files.length, 1);
  assert.ok(rendered(result.messages.slice(1)).includes("1 attachment"));
});

test("more attachments than one message allows spill into extra chunks", async () => {
  mockChat({
    text: "twelve files",
    attachments: Array.from({ length: 12 }, (_, i) => attachment(`f${i}.png`)),
  } as Partial<ChatResult>);

  const result = await handleConversationTurn(params());

  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.files.length, 10);
  assert.equal(result.messages[1]?.files.length, 2);
  assert.ok(rendered(result.messages.slice(1)).includes("2 attachments"));
});

// proactive compaction

test("a half-full context schedules a background compaction", async () => {
  mockChat({ text: "long one", lastInputTokens: 150_000 });

  await handleConversationTurn(params({ channelId: "chan-compact" }));

  assert.equal(mocks.compactConversation.mock.calls.length, 1);
});

test("a comfortable context leaves compaction alone", async () => {
  mockChat({ text: "short one", lastInputTokens: 1_000 });

  await handleConversationTurn(params());

  assert.equal(mocks.compactConversation.mock.calls.length, 0);
});
