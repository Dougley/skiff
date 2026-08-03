import assert from "node:assert/strict";
import { afterEach, beforeAll, test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";
import {
  installFakeClient,
  lastReplyText,
  loaderContext,
  makeInteraction,
  stubRegistry,
} from "./harness.js";

bootstrapTestEnv();
installFakeClient();

const { runMigrations } = await import("../../../src/db/migrate.js");
const { getConversation, setConversationModelOverride } = await import(
  "../../../src/db/queries.js"
);
const { env } = await import("../../../src/config/env.js");
const { logger } = await import("../../../src/config/logger.js");
const { ModelCommand } = await import("../../../src/discord/commands/model.js");

const command = new ModelCommand(loaderContext("model"), {});
const DEFAULT_MODEL = env.LLM_DEFAULT_MODEL;

beforeAll(async () => {
  await runMigrations();
});

afterEach(() => {
  env.GUILD_ID = undefined;
  env.LLM_ALLOWED_MODELS = "";
});

// registration

test("registers three subcommands globally when GUILD_ID is unset", () => {
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(chatInput.length, 1);
  const json = chatInput[0]?.builder.toJSON();
  assert.equal(json?.name, "model");
  assert.deepEqual(
    json?.options?.map((o) => o.name),
    ["set", "show", "reset"]
  );
  assert.equal(json?.integration_types?.length, 2);
});

test("adds a guild-scoped registration when GUILD_ID is set", () => {
  env.GUILD_ID = "guild-42";
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(chatInput.length, 2);
  assert.deepEqual(chatInput[0]?.options, { guildIds: ["guild-42"] });
});

test("bakes the allowlist into the set option's choices", () => {
  env.LLM_ALLOWED_MODELS = "gpt-a,gpt-b";
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  const setOption = chatInput[0]?.builder.toJSON().options?.[0] as {
    options?: { choices?: { value: string }[] }[];
  };
  assert.deepEqual(
    setOption.options?.[0]?.choices?.map((choice) => choice.value),
    ["gpt-a", "gpt-b"]
  );
});

test("warns when the allowlist exceeds Discord's choice limit", () => {
  env.LLM_ALLOWED_MODELS = Array.from(
    { length: 30 },
    (_, i) => `model-${i}`
  ).join(",");
  const warnings: unknown[] = [];
  const realWarn = logger.warn;
  logger.warn = ((message: unknown) => {
    warnings.push(message);
  }) as typeof logger.warn;

  try {
    const { chatInput, registry } = stubRegistry();
    command.registerApplicationCommands(registry);
    const setOption = chatInput[0]?.builder.toJSON().options?.[0] as {
      options?: { choices?: unknown[] }[];
    };
    assert.equal(setOption.options?.[0]?.choices?.length, 25);
  } finally {
    logger.warn = realWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]), /only the first 25 appear/);
});

// set

test("stores an allowed model override for the channel", async () => {
  env.LLM_ALLOWED_MODELS = "gpt-a,gpt-b";
  const interaction = makeInteraction({
    guildId: "guild-1",
    channelId: "chan-set",
    options: { subcommand: "set", strings: { model: "  gpt-b  " } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    "Now using `gpt-b` in this channel. The conversation history carries over."
  );
  const conversation = await getConversation({
    channelId: "chan-set",
    guildId: "guild-1",
  });
  assert.equal(conversation?.modelOverride, "gpt-b");
});

test("refuses a model outside the allowlist and lists what is available", async () => {
  env.LLM_ALLOWED_MODELS = "gpt-a,gpt-b";
  const interaction = makeInteraction({
    channelId: "chan-refuse",
    options: { subcommand: "set", strings: { model: "gpt-z" } },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.match(reply, /^`gpt-z` isn't an allowed model\. Pick one of:/);
  assert.match(reply, /- `gpt-a`\n- `gpt-b`/);
  assert.equal(
    await getConversation({ channelId: "chan-refuse", guildId: null }),
    null
  );
});

// show

test("show reports the default model when nothing is pinned", async () => {
  const interaction = makeInteraction({
    channelId: "chan-show-default",
    options: { subcommand: "show" },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.ok(
    reply.startsWith(
      `This channel is using \`${DEFAULT_MODEL}\`, the default (\`LLM_DEFAULT_MODEL\`).`
    ),
    reply
  );
  assert.match(
    reply,
    /Any model your provider accepts \(`LLM_ALLOWED_MODELS` is unset\)\./
  );
});

test("show reports a pinned model as channel-set", async () => {
  env.LLM_ALLOWED_MODELS = "gpt-a";
  await setConversationModelOverride({
    channelId: "chan-show-pinned",
    guildId: null,
    model: "gpt-a",
  });
  const interaction = makeInteraction({
    channelId: "chan-show-pinned",
    options: { subcommand: "show" },
  });

  await command.chatInputRun(interaction as never);

  assert.match(
    lastReplyText(interaction),
    /^This channel is using `gpt-a`, set for this channel\./
  );
});

test("show truncates a long allowlist with a remainder note", async () => {
  env.LLM_ALLOWED_MODELS = Array.from(
    { length: 45 },
    (_, i) => `model-${i}`
  ).join(",");
  const interaction = makeInteraction({
    channelId: "chan-show-long",
    options: { subcommand: "show" },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.match(reply, /- `model-39`/);
  assert.ok(!reply.includes("`model-40`"), "expected the tail to be dropped");
  assert.match(reply, /…and 5 more$/);
});

// reset

test("reset clears the override and names the default model", async () => {
  env.LLM_ALLOWED_MODELS = "gpt-a";
  await setConversationModelOverride({
    channelId: "chan-reset",
    guildId: null,
    model: "gpt-a",
  });
  const interaction = makeInteraction({
    channelId: "chan-reset",
    options: { subcommand: "reset" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    `Back to the default model, \`${DEFAULT_MODEL}\`.`
  );
  const conversation = await getConversation({
    channelId: "chan-reset",
    guildId: null,
  });
  assert.equal(conversation?.modelOverride, null);
});

test("rejects an unrecognised subcommand", async () => {
  const interaction = makeInteraction({
    options: { subcommand: "explode" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(lastReplyText(interaction), "Unknown subcommand.");
});
