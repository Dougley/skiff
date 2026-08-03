import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";
import {
  installFakeClient,
  lastReply,
  loaderContext,
  makeInteraction,
  stubRegistry,
} from "./harness.js";

vi.mock("../../../src/ai/llm/conversation-turn.js", () => ({
  handleConversationTurn: vi.fn(),
}));

bootstrapTestEnv();
const client = installFakeClient();

const { handleConversationTurn } = await import(
  "../../../src/ai/llm/conversation-turn.js"
);
const { env } = await import("../../../src/config/env.js");
const { logger } = await import("../../../src/config/logger.js");
const { ApplicationCommandType, MessageFlags } = await import("discord.js");
const { AskMessageCommand } = await import(
  "../../../src/discord/commands/ask-message.js"
);

const turn = vi.mocked(handleConversationTurn);
const command = new AskMessageCommand(loaderContext("ask-message"), {});

type TurnParams = Parameters<typeof handleConversationTurn>[0];

const chunk = (label: string) => ({
  components: [{ label } as never],
  files: [] as never[],
});

function respondWith(...labels: string[]) {
  turn.mockImplementation(async () => ({
    messages: labels.map(chunk),
    text: labels.join(" "),
    usedTools: false,
    historyLength: labels.length,
  }));
}

/** A message-context-menu interaction, with the type guard wired to `isMessage`. */
function contextInteraction(
  overrides: Parameters<typeof makeInteraction>[0] & {
    isMessage?: boolean;
    targetMessage?: unknown;
  } = {}
) {
  const interaction = makeInteraction(overrides);
  const targetMessage = overrides.targetMessage ?? {
    id: "msg-1",
    content: "  the original text  ",
    author: { id: "author-9", username: "author" },
  };
  return Object.assign(interaction, {
    isMessageContextMenuCommand: () => overrides.isMessage ?? true,
    targetMessage,
  });
}

afterEach(() => {
  turn.mockReset();
  env.GUILD_ID = undefined;
});

// registration

test("registers one global message context command when GUILD_ID is unset", () => {
  const { contextMenu, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(contextMenu.length, 1);
  assert.equal(contextMenu[0]?.command.name, "Ask about message");
  assert.equal(contextMenu[0]?.command.type, ApplicationCommandType.Message);
  assert.equal(
    (contextMenu[0]?.command.integrationTypes as unknown[]).length,
    2
  );
  assert.equal((contextMenu[0]?.command.contexts as unknown[]).length, 3);
});

test("adds a guild-scoped registration when GUILD_ID is set", () => {
  env.GUILD_ID = "guild-42";
  const { contextMenu, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(contextMenu.length, 2);
  assert.deepEqual(contextMenu[0]?.options, { guildIds: ["guild-42"] });
  assert.equal(contextMenu[0]?.command.integrationTypes, undefined);
});

// contextMenuRun

test("rejects an interaction that is not a message context command", async () => {
  const interaction = contextInteraction({ isMessage: false });

  await command.contextMenuRun(interaction as never);

  assert.deepEqual(interaction.reply.mock.calls[0]?.[0], {
    flags: MessageFlags.Ephemeral,
    content: "This command can only be used on a message.",
  });
  assert.equal(interaction.deferReply.mock.calls.length, 0);
  assert.equal(turn.mock.calls.length, 0);
});

test("builds the prompt from the target message and defers ephemerally", async () => {
  respondWith("answer");
  const members = { fetch: vi.fn(async () => ({ displayName: "Nickname" })) };
  const interaction = contextInteraction({
    guildId: "guild-1",
    guild: { name: "Test Guild", members },
    channelId: "chan-1",
    channel: { name: "general" },
  });

  await command.contextMenuRun(interaction as never);

  assert.deepEqual(interaction.deferReply.mock.calls[0]?.[0], {
    flags: MessageFlags.Ephemeral,
  });
  const params = turn.mock.calls[0]?.[0] as TurnParams;
  assert.equal(
    params.content,
    "Please help me with this selected message from author (author-9):\n\nthe original text"
  );
  assert.equal(params.skipInitialStatus, true);
  assert.equal(params.toolContext.client, client);
  assert.deepEqual(params.messageContext, {
    displayName: "Nickname",
    username: "tester",
    channelName: "#general",
    guildName: "Test Guild",
    isDM: false,
  });
});

test("substitutes a placeholder for an empty message body", async () => {
  respondWith("answer");
  const interaction = contextInteraction({
    targetMessage: {
      id: "msg-2",
      content: "   ",
      author: { id: "author-9", username: "author" },
    },
  });

  await command.contextMenuRun(interaction as never);

  assert.match(
    (turn.mock.calls[0]?.[0] as TurnParams).content,
    /\[no text content\]$/
  );
});

test("falls back to the global display name in a DM", async () => {
  respondWith("answer");
  const interaction = contextInteraction({ guildId: null, channel: {} });

  await command.contextMenuRun(interaction as never);

  const params = turn.mock.calls[0]?.[0] as TurnParams;
  assert.deepEqual(params.messageContext, {
    displayName: "Tester",
    username: "tester",
    channelName: "DM",
    guildName: null,
    isDM: true,
  });
});

test("falls back to the global display name when the member fetch fails", async () => {
  respondWith("answer");
  const interaction = contextInteraction({
    guildId: "guild-1",
    guild: {
      name: "Test Guild",
      members: { fetch: vi.fn(async () => Promise.reject(new Error("gone"))) },
    },
  });

  await command.contextMenuRun(interaction as never);

  assert.equal(
    (turn.mock.calls[0]?.[0] as TurnParams).messageContext.displayName,
    "Tester"
  );
});

test("edits in the first chunk and follows up with the rest", async () => {
  respondWith("one", "two");
  const interaction = contextInteraction();

  await command.contextMenuRun(interaction as never);

  assert.deepEqual(
    (lastReply(interaction) as { components: unknown }).components,
    [{ label: "one" }]
  );
  assert.deepEqual(
    (interaction.followUp.mock.calls[0]?.[0] as { components: unknown })
      .components,
    [{ label: "two" }]
  );
});

test("says so when the turn produced no messages", async () => {
  respondWith();
  const interaction = contextInteraction();

  await command.contextMenuRun(interaction as never);

  assert.deepEqual(lastReply(interaction), {
    content: "I had nothing to say.",
  });
});

test("renders tool status updates and logs failures", async () => {
  const warnings: unknown[] = [];
  const realWarn = logger.warn;
  logger.warn = ((message: unknown) => {
    warnings.push(message);
  }) as typeof logger.warn;
  const interaction = contextInteraction();
  let edited: unknown = "unset";
  turn.mockImplementation(async (params) => {
    params.onToolStatus?.("searching");
    edited = await params.toolContext.editStatusMessage?.({
      content: "working",
      components: [],
    });
    return {
      messages: [chunk("done")],
      text: "done",
      usedTools: true,
      historyLength: 2,
    };
  });

  try {
    await command.contextMenuRun(interaction as never);
  } finally {
    logger.warn = realWarn;
  }

  assert.deepEqual(edited, { id: "status-message" });
  assert.deepEqual(warnings, []);
  const statusEdit = interaction.editReply.mock.calls
    .map(
      (call) => call[0] as { components?: { data?: { content?: string } }[] }
    )
    .find((arg) => arg.components?.[0]?.data?.content === "searching");
  assert.ok(statusEdit, "expected the tool status to be rendered");
});

test("logs and swallows Discord failures from both status paths", async () => {
  const warnings: unknown[] = [];
  const realWarn = logger.warn;
  logger.warn = ((message: unknown) => {
    warnings.push(message);
  }) as typeof logger.warn;
  const interaction = contextInteraction();
  // only the two status edits fail; the final response still lands
  const boom = async () => {
    throw new Error("discord is down");
  };
  interaction.editReply
    .mockImplementationOnce(boom)
    .mockImplementationOnce(boom);
  let edited: unknown = "unset";
  turn.mockImplementation(async (params) => {
    params.onToolStatus?.("searching");
    edited = await params.toolContext.editStatusMessage?.({
      content: null,
      components: [],
    });
    return {
      messages: [chunk("done")],
      text: "done",
      usedTools: true,
      historyLength: 2,
    };
  });

  try {
    await command.contextMenuRun(interaction as never);
  } finally {
    logger.warn = realWarn;
  }

  assert.equal(edited, null);
  assert.deepEqual([...warnings].sort(), [
    "Failed to edit status message",
    "Failed to update tool status",
  ]);
  assert.deepEqual(
    (lastReply(interaction) as { components: unknown }).components,
    [{ label: "done" }]
  );
});
