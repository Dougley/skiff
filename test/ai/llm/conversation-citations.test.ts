import assert from "node:assert/strict";
import type { Client } from "discord.js";
import { beforeAll, test, vi } from "vitest";
import { bootstrapTestEnv, MISSING_MCP_CONFIG } from "../../helpers/setup.js";

// The parser is covered directly in citations.test.ts. What this file pins is
// the wiring: that the turn routes the stripped body to the render and the
// lifted sources to the footer, rather than either one silently no-opping.
const llm = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("../../../src/ai/llm/streaming.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/ai/llm/streaming.js")>();
  return { ...actual, chat: llm.chat };
});

bootstrapTestEnv();
process.env.MCP_CONFIG_PATH = MISSING_MCP_CONFIG;

let handleConversationTurn: typeof import("../../../src/ai/llm/conversation-turn.js").handleConversationTurn;

beforeAll(async () => {
  const { runMigrations } = await import("../../../src/db/migrate.js");
  await runMigrations();
  ({ handleConversationTurn } = await import(
    "../../../src/ai/llm/conversation-turn.js"
  ));
});

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

function mockReply(text: string) {
  llm.chat.mockResolvedValue({
    text,
    responseMessages: [{ id: "a1", role: "assistant", content: text }],
    usage,
    lastInputTokens: 100,
    finishReason: "stop",
    stepCount: 1,
    attachments: [],
  });
}

function params(channelId: string) {
  return {
    content: "when did it open?",
    userId: "user-1",
    channelId,
    guildId: "guild-1",
    skipMemory: true,
    toolContext: {
      client: {} as Client,
      guildId: "guild-1",
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
  };
}

const rendered = (messages: Array<{ components: unknown[] }>) =>
  JSON.stringify(messages);

test("a trailing citation list becomes the footer, not body text", async () => {
  mockReply(
    "The bridge opened in 1932.¹\n\n¹ [Harbour history](https://example.com/history)"
  );

  const result = await handleConversationTurn(params("chan-cite"));

  // the returned text is what feeds embeddings and fact extraction
  assert.equal(result.text, "The bridge opened in 1932.¹");

  const out = rendered(result.messages);
  // rendered as our footer shape
  assert.ok(
    out.includes("-# [¹](https://example.com/history) Harbour history"),
    "the source should render as a footer line"
  );
  // and not left sitting in the body as the model wrote it
  assert.ok(
    !out.includes("¹ [Harbour history]"),
    "the raw citation list should not survive into the body"
  );
});

test("a reply with no citations passes through untouched", async () => {
  const text = "Nothing to cite here.\n\nJust two paragraphs.";
  mockReply(text);

  const result = await handleConversationTurn(params("chan-nocite"));

  assert.equal(result.text, text);
  const out = rendered(result.messages);
  assert.ok(out.includes("Nothing to cite here."));
  assert.ok(out.includes("Just two paragraphs."));
});
