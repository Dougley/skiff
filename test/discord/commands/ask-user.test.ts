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
const { AskUserCommand } = await import(
  "../../../src/discord/commands/ask-user.js"
);

const turn = vi.mocked(handleConversationTurn);
const command = new AskUserCommand(loaderContext("ask-user"), {});

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

const TARGET = {
  id: "target-7",
  username: "targetuser",
  displayName: "Target User",
};

function contextInteraction(
  overrides: Parameters<typeof makeInteraction>[0] & {
    isUser?: boolean;
    targetUser?: unknown;
  } = {}
) {
  const interaction = makeInteraction(overrides);
  return Object.assign(interaction, {
    isUserContextMenuCommand: () => overrides.isUser ?? true,
    targetUser: overrides.targetUser ?? TARGET,
  });
}

afterEach(() => {
  turn.mockReset();
  env.GUILD_ID = undefined;
});

// registration

test("registers one global user context command when GUILD_ID is unset", () => {
  const { contextMenu, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(contextMenu.length, 1);
  assert.equal(contextMenu[0]?.command.name, "Ask about user");
  assert.equal(contextMenu[0]?.command.type, ApplicationCommandType.User);
  assert.equal(
    (contextMenu[0]?.command.integrationTypes as unknown[]).length,
    2
  );
});

test("adds a guild-scoped registration when GUILD_ID is set", () => {
  env.GUILD_ID = "guild-42";
  const { contextMenu, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(contextMenu.length, 2);
  assert.deepEqual(contextMenu[0]?.options, { guildIds: ["guild-42"] });
});

// contextMenuRun

test("rejects an interaction that is not a user context command", async () => {
  const interaction = contextInteraction({ isUser: false });

  await command.contextMenuRun(interaction as never);

  assert.deepEqual(interaction.reply.mock.calls[0]?.[0], {
    flags: MessageFlags.Ephemeral,
    content: "This command can only be used on a user.",
  });
  assert.equal(interaction.deferReply.mock.calls.length, 0);
  assert.equal(turn.mock.calls.length, 0);
});

test("describes the target user and includes their server nickname", async () => {
  respondWith("answer");
  const fetch = vi.fn(async (id: string) => ({
    displayName: id === TARGET.id ? "Nickname of target" : "Nickname of caller",
  }));
  const interaction = contextInteraction({
    guildId: "guild-1",
    guild: { name: "Test Guild", members: { fetch } },
    channel: { name: "general" },
  });

  await command.contextMenuRun(interaction as never);

  assert.deepEqual(interaction.deferReply.mock.calls[0]?.[0], {
    flags: MessageFlags.Ephemeral,
  });
  const params = turn.mock.calls[0]?.[0] as TurnParams;
  assert.equal(
    params.content,
    [
      "Please help me with this selected user:",
      "",
      "- username: targetuser",
      "- user id: target-7",
      "- display name: Target User",
      "- server nickname: Nickname of target",
    ].join("\n")
  );
  assert.equal(params.messageContext.displayName, "Nickname of caller");
  assert.equal(params.toolContext.client, client);
  // the target is fetched first, then the caller
  assert.deepEqual(
    fetch.mock.calls.map((call) => call[0]),
    ["target-7", "user-1"]
  );
});

test("omits the nickname line when the target member cannot be fetched", async () => {
  respondWith("answer");
  const interaction = contextInteraction({
    guildId: "guild-1",
    guild: {
      name: "Test Guild",
      members: { fetch: vi.fn(async () => Promise.reject(new Error("gone"))) },
    },
  });

  await command.contextMenuRun(interaction as never);

  const params = turn.mock.calls[0]?.[0] as TurnParams;
  assert.ok(!params.content.includes("server nickname"));
  assert.equal(params.messageContext.displayName, "Tester");
});

test("omits the nickname line in a DM and marks the turn as a DM", async () => {
  respondWith("answer");
  const interaction = contextInteraction({ guildId: null, channel: {} });

  await command.contextMenuRun(interaction as never);

  const params = turn.mock.calls[0]?.[0] as TurnParams;
  assert.ok(!params.content.includes("server nickname"));
  assert.deepEqual(params.messageContext, {
    displayName: "Tester",
    username: "tester",
    channelName: "DM",
    guildName: null,
    isDM: true,
  });
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

test("renders tool status updates through the deferred reply", async () => {
  const interaction = contextInteraction();
  let edited: unknown = "unset";
  turn.mockImplementation(async (params) => {
    params.onToolStatus?.("looking things up");
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

  await command.contextMenuRun(interaction as never);

  assert.deepEqual(edited, { id: "status-message" });
  const statusEdit = interaction.editReply.mock.calls
    .map(
      (call) => call[0] as { components?: { data?: { content?: string } }[] }
    )
    .find((arg) => arg.components?.[0]?.data?.content === "looking things up");
  assert.ok(statusEdit, "expected the tool status to be rendered");
});

test("logs and swallows Discord failures from both status paths", async () => {
  const warnings: unknown[] = [];
  const realWarn = logger.warn;
  logger.warn = ((message: unknown) => {
    warnings.push(message);
  }) as typeof logger.warn;
  const interaction = contextInteraction();
  const boom = async () => {
    throw new Error("discord is down");
  };
  interaction.editReply
    .mockImplementationOnce(boom)
    .mockImplementationOnce(boom);
  let edited: unknown = "unset";
  turn.mockImplementation(async (params) => {
    params.onToolStatus?.("looking things up");
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
});
