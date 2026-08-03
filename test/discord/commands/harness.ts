/**
 * Shared scaffolding for Discord command tests.
 *
 * Sapphire pieces normally come out of a store; the loader context here is
 * just enough for `Piece`'s constructor (store, path/root for PieceLocation,
 * name). Command constructors additionally read
 * `container.client.options.defaultCooldown`, so `installFakeClient` must run
 * before `new SomeCommand(...)`.
 *
 * Nothing in this file imports src/ modules — it is safe to load before
 * `bootstrapTestEnv()` has run.
 */
import { container } from "@sapphire/framework";
import { SlashCommandBuilder } from "discord.js";
import { vi } from "vitest";

export function loaderContext(name: string) {
  return {
    name,
    path: `/virtual/commands/${name}.js`,
    root: "/virtual",
    store: { name: "commands" },
  } as never;
}

/** Give the shared Sapphire container a client stub; returns it for asserts. */
export function installFakeClient(
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  const client = { options: {}, ...extra };
  (container as unknown as { client: unknown }).client = client;
  return client;
}

export type ChatInputRegistration = {
  builder: SlashCommandBuilder;
  options: Record<string, unknown> | undefined;
};

export type ContextMenuRegistration = {
  command: Record<string, unknown>;
  options: Record<string, unknown> | undefined;
};

/**
 * Stand-in for Sapphire's ApplicationCommandRegistry that immediately invokes
 * builder callbacks against a real SlashCommandBuilder, capturing the result.
 */
export function stubRegistry() {
  const chatInput: ChatInputRegistration[] = [];
  const contextMenu: ContextMenuRegistration[] = [];
  const registry = {
    registerChatInputCommand(
      build: (builder: SlashCommandBuilder) => SlashCommandBuilder,
      options?: Record<string, unknown>
    ) {
      chatInput.push({ builder: build(new SlashCommandBuilder()), options });
    },
    registerContextMenuCommand(
      command: Record<string, unknown>,
      options?: Record<string, unknown>
    ) {
      contextMenu.push({ command, options });
    },
  };
  return { chatInput, contextMenu, registry: registry as never };
}

export type OptionValues = {
  strings?: Record<string, string | null>;
  integers?: Record<string, number | null>;
  booleans?: Record<string, boolean | null>;
  channels?: Record<string, { id: string } | null>;
  subcommand?: string;
};

function makeOptions(values: OptionValues) {
  return {
    getString: (name: string) => values.strings?.[name] ?? null,
    getInteger: (name: string) => values.integers?.[name] ?? null,
    getBoolean: (name: string) => values.booleans?.[name] ?? null,
    getChannel: (name: string) => values.channels?.[name] ?? null,
    getSubcommand: () => values.subcommand ?? "",
  };
}

export type FakeInteraction = ReturnType<typeof makeInteraction>;

/**
 * A plain-object interaction. `editReply` resolves to a message-ish object;
 * throw behaviour can be layered on per-test via `mockImplementation*`.
 */
export function makeInteraction(
  overrides: {
    guildId?: string | null;
    guild?: unknown;
    channelId?: string;
    channel?: unknown;
    user?: { id: string; username: string; displayName: string };
    options?: OptionValues;
  } = {}
) {
  return {
    user: overrides.user ?? {
      id: "user-1",
      username: "tester",
      displayName: "Tester",
    },
    guildId: overrides.guildId ?? null,
    guild: overrides.guild ?? null,
    channelId: overrides.channelId ?? "channel-1",
    channel: overrides.channel ?? null,
    reply: vi.fn(async (_options?: unknown) => undefined),
    deferReply: vi.fn(async (_options?: unknown) => undefined),
    editReply: vi.fn(async (_options?: unknown) => ({ id: "status-message" })),
    followUp: vi.fn(async (_options?: unknown) => undefined),
    options: makeOptions(overrides.options ?? {}),
  };
}

/** The argument of the most recent editReply call. */
export function lastReply(interaction: FakeInteraction): unknown {
  const calls = interaction.editReply.mock.calls as unknown as unknown[][];
  return calls.at(-1)?.[0];
}

/** The most recent editReply argument, asserted to be plain text. */
export function lastReplyText(interaction: FakeInteraction): string {
  const value = lastReply(interaction);
  if (typeof value !== "string") {
    throw new Error(`expected a string reply, got ${JSON.stringify(value)}`);
  }
  return value;
}
