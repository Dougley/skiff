import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";
import {
  installFakeClient,
  lastReply,
  lastReplyText,
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
const { AskCommand } = await import("../../../src/discord/commands/ask.js");

const turn = vi.mocked(handleConversationTurn);
const command = new AskCommand(loaderContext("ask"), {});

/** A minimal ParsedMessage-shaped chunk. */
const chunk = (label: string) => ({
  components: [{ label } as never],
  files: [] as never[],
});

type TurnParams = Parameters<typeof handleConversationTurn>[0];

/** Default mock: no tool activity, a single response chunk. */
function respondWith(...labels: string[]) {
  turn.mockImplementation(async () => ({
    messages: labels.map(chunk),
    text: labels.join(" "),
    usedTools: false,
    historyLength: labels.length,
  }));
}

afterEach(() => {
  turn.mockReset();
  env.GUILD_ID = undefined;
  env.LLM_ALLOWED_MODELS = "";
});

// registration

test("registers a single global command when GUILD_ID is unset", () => {
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(chatInput.length, 1);
  const json = chatInput[0]?.builder.toJSON();
  assert.equal(json?.name, "ask");
  assert.equal(json?.integration_types?.length, 2);
  assert.equal(json?.contexts?.length, 3);
  // question (required) + model (optional), and no baked choices
  assert.deepEqual(
    json?.options?.map((o) => [o.name, o.required ?? false]),
    [
      ["question", true],
      ["model", false],
    ]
  );
  assert.equal(
    (json?.options?.[1] as { choices?: unknown[] })?.choices,
    undefined
  );
});

test("adds a guild-scoped registration when GUILD_ID is set", () => {
  env.GUILD_ID = "guild-42";
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(chatInput.length, 2);
  assert.deepEqual(chatInput[0]?.options, { guildIds: ["guild-42"] });
  assert.equal(chatInput[1]?.options, undefined);
});

test("bakes the allowlist into the model option as choices", () => {
  env.LLM_ALLOWED_MODELS = "gpt-a, gpt-b";
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  const modelOption = chatInput[0]?.builder.toJSON().options?.[1] as {
    choices?: { name: string; value: string }[];
  };
  assert.deepEqual(
    modelOption.choices?.map((choice) => [choice.name, choice.value]),
    [
      ["gpt-a", "gpt-a"],
      ["gpt-b", "gpt-b"],
    ]
  );
});

test("caps baked choices at Discord's limit", () => {
  const many = Array.from({ length: 30 }, (_, i) => `m${i}`);
  env.LLM_ALLOWED_MODELS = many.join(",");
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  const modelOption = chatInput[0]?.builder.toJSON().options?.[1] as {
    choices?: unknown[];
  };
  assert.equal(modelOption.choices?.length, 25);
});

// chatInputRun

test("refuses a model that is not on the allowlist without running the turn", async () => {
  env.LLM_ALLOWED_MODELS = "gpt-a";
  const interaction = makeInteraction({
    options: { strings: { question: "hi", model: " gpt-z " } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(interaction.deferReply.mock.calls.length, 1);
  assert.match(lastReplyText(interaction), /^`gpt-z` isn't an allowed model/);
  assert.equal(turn.mock.calls.length, 0);
});

test("passes the question, model override and guild context to the turn", async () => {
  env.LLM_ALLOWED_MODELS = "gpt-a";
  respondWith("answer");
  const members = {
    fetch: vi.fn(async (_userId: string) => ({ displayName: "Nickname" })),
  };
  const interaction = makeInteraction({
    guildId: "guild-1",
    guild: { name: "Test Guild", members },
    channelId: "chan-1",
    channel: { name: "general" },
    options: { strings: { question: "why?", model: "gpt-a" } },
  });

  await command.chatInputRun(interaction as never);

  const params = turn.mock.calls[0]?.[0] as TurnParams;
  assert.equal(params.content, "why?");
  assert.equal(params.modelOverride, "gpt-a");
  assert.equal(params.skipInitialStatus, true);
  assert.equal(params.userId, "user-1");
  assert.equal(params.channelId, "chan-1");
  assert.equal(params.guildId, "guild-1");
  assert.deepEqual(params.messageContext, {
    displayName: "Nickname",
    username: "tester",
    channelName: "#general",
    guildName: "Test Guild",
    isDM: false,
  });
  assert.equal(params.toolContext.client, client);
  assert.equal(members.fetch.mock.calls[0]?.[0], "user-1");
});

test("falls back to the global display name when the member fetch fails", async () => {
  respondWith("answer");
  const interaction = makeInteraction({
    guildId: "guild-1",
    guild: {
      name: "Test Guild",
      members: { fetch: vi.fn(async () => Promise.reject(new Error("nope"))) },
    },
    options: { strings: { question: "why?" } },
  });

  await command.chatInputRun(interaction as never);

  const params = turn.mock.calls[0]?.[0] as TurnParams;
  assert.equal(params.messageContext.displayName, "Tester");
  assert.equal(params.modelOverride, undefined);
});

test("labels a DM channel and marks the turn as a DM", async () => {
  respondWith("answer");
  const interaction = makeInteraction({
    guildId: null,
    channel: { id: "dm-1" },
    options: { strings: { question: "why?" } },
  });

  await command.chatInputRun(interaction as never);

  const params = turn.mock.calls[0]?.[0] as TurnParams;
  assert.equal(params.messageContext.channelName, "DM");
  assert.equal(params.messageContext.guildName, null);
  assert.equal(params.messageContext.isDM, true);
});

test("edits the first chunk in and follows up with the rest", async () => {
  respondWith("one", "two", "three");
  const interaction = makeInteraction({
    options: { strings: { question: "why?" } },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReply(interaction) as { components: { label: string }[] };
  assert.deepEqual(reply.components, [{ label: "one" }]);
  assert.deepEqual(
    interaction.followUp.mock.calls.map(
      (call) => (call[0] as { components: { label: string }[] }).components
    ),
    [[{ label: "two" }], [{ label: "three" }]]
  );
});

test("says so when the turn produced no messages", async () => {
  respondWith();
  const interaction = makeInteraction({
    options: { strings: { question: "why?" } },
  });

  await command.chatInputRun(interaction as never);

  assert.deepEqual(lastReply(interaction), {
    content: "I had nothing to say.",
  });
  assert.equal(interaction.followUp.mock.calls.length, 0);
});

test("coalesces queued tool statuses down to the newest one", async () => {
  turn.mockImplementation(async (params) => {
    // the first push starts applying at once; b and c queue behind it and
    // collapse, so b never reaches Discord
    params.onToolStatus?.("running tool a");
    params.onToolStatus?.("running tool b");
    params.onToolStatus?.("running tool c");
    return {
      messages: [chunk("done")],
      text: "done",
      usedTools: true,
      historyLength: 2,
    };
  });
  const interaction = makeInteraction({
    options: { strings: { question: "why?" } },
  });

  await command.chatInputRun(interaction as never);

  const statusEdits = interaction.editReply.mock.calls
    .map(
      (call) => call[0] as { components?: { data?: { content?: string } }[] }
    )
    .flatMap((arg) => arg.components ?? [])
    .map((component) => (component as { data?: { content?: string } }).data)
    .filter((data) => typeof data?.content === "string")
    .map((data) => data?.content);
  assert.deepEqual(statusEdits, ["running tool a", "running tool c"]);
});

test("tool status failures are logged instead of breaking the turn", async () => {
  respondWith("done");
  const warnings: unknown[] = [];
  const realWarn = logger.warn;
  logger.warn = ((message: unknown) => {
    warnings.push(message);
  }) as typeof logger.warn;
  const interaction = makeInteraction({
    options: { strings: { question: "why?" } },
  });
  interaction.editReply.mockImplementationOnce(async () => {
    throw new Error("discord is down");
  });
  turn.mockImplementation(async (params) => {
    params.onToolStatus?.("running a tool");
    return {
      messages: [chunk("done")],
      text: "done",
      usedTools: true,
      historyLength: 2,
    };
  });

  try {
    await command.chatInputRun(interaction as never);
  } finally {
    logger.warn = realWarn;
  }

  assert.deepEqual(warnings, ["Failed to update tool status"]);
  const reply = lastReply(interaction) as { components: { label: string }[] };
  assert.deepEqual(reply.components, [{ label: "done" }]);
});

test("editStatusMessage returns the edited message to the tool context", async () => {
  respondWith("done");
  const interaction = makeInteraction({
    options: { strings: { question: "why?" } },
  });

  let edited: unknown;
  turn.mockImplementation(async (params) => {
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

  await command.chatInputRun(interaction as never);

  assert.deepEqual(edited, { id: "status-message" });
});

test("editStatusMessage swallows a Discord failure and returns null", async () => {
  const warnings: unknown[] = [];
  const realWarn = logger.warn;
  logger.warn = ((message: unknown) => {
    warnings.push(message);
  }) as typeof logger.warn;
  const interaction = makeInteraction({
    options: { strings: { question: "why?" } },
  });
  interaction.editReply.mockImplementationOnce(async () => {
    throw new Error("unknown message");
  });

  let edited: unknown = "unset";
  turn.mockImplementation(async (params) => {
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
    await command.chatInputRun(interaction as never);
  } finally {
    logger.warn = realWarn;
  }

  assert.equal(edited, null);
  assert.deepEqual(warnings, ["Failed to edit status message"]);
});
