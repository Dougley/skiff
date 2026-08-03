import assert from "node:assert/strict";
import { ChannelType, type Client, Collection } from "discord.js";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { createDiscordTools } = await import("../../../src/ai/tools/discord.js");

const toolOpts = { toolCallId: "test-call", messages: [] } as never;

// minimal discord.js stand-ins
//
// The tools only ever touch a handful of properties, so the fakes carry
// exactly those. Real `Collection`s are used throughout because the tools rely
// on filter/map/sort/first/size behaving like discord.js caches.

function fakeMember(
  id: string,
  {
    username = `user-${id}`,
    displayName = `Display ${id}`,
    bot = false,
    roles = [] as string[],
    joinedAt = new Date("2024-03-01T12:00:00.000Z") as Date | null,
  } = {}
) {
  const roleCache = new Collection<string, { name: string }>();
  roleCache.set("everyone", { name: "@everyone" });
  for (const role of roles) roleCache.set(role, { name: role });
  return {
    id,
    user: { username, bot },
    displayName,
    roles: { cache: roleCache },
    joinedAt,
  };
}

function fakeMessage(
  id: string,
  {
    content = `message ${id}`,
    embeds = [] as Array<{ title?: string; description?: string }>,
    attachments = [] as string[],
    react = async (_emoji: string) => {},
  } = {}
) {
  const attachmentCache = new Collection<string, { url: string }>();
  for (const [i, url] of attachments.entries()) {
    attachmentCache.set(String(i), { url });
  }
  return {
    id,
    author: { username: "author", id: "author-id" },
    content,
    embeds,
    attachments: attachmentCache,
    createdAt: new Date("2024-05-05T00:00:00.000Z"),
    react,
  };
}

interface FakeGuildOptions {
  members?: ReturnType<typeof fakeMember>[];
  fetchByQuery?: (query: string) => ReturnType<typeof fakeMember>[];
}

function fakeGuild(id: string, opts: FakeGuildOptions = {}) {
  const memberCache = new Collection<string, unknown>();
  for (const m of opts.members ?? []) memberCache.set(m.id, m);

  const channelCache = new Collection<string, unknown>();
  channelCache.set("cat-1", {
    id: "cat-1",
    name: "Text Channels",
    type: ChannelType.GuildCategory,
    parentId: null,
  });
  channelCache.set("chan-1", {
    id: "chan-1",
    name: "general",
    type: ChannelType.GuildText,
    parentId: "cat-1",
  });

  const roleCache = new Collection<string, unknown>();
  roleCache.set("r-everyone", {
    name: "@everyone",
    hexColor: "#000000",
    position: 0,
    members: new Collection(),
  });
  roleCache.set("r-mod", {
    name: "Moderator",
    hexColor: "#ff0000",
    position: 5,
    members: new Collection([["m-1", {}]]),
  });
  roleCache.set("r-member", {
    name: "Member",
    hexColor: "#00ff00",
    position: 1,
    members: new Collection(),
  });

  return {
    id,
    name: "Test Guild",
    description: "a place to test",
    memberCount: 42,
    ownerId: "owner-1",
    createdAt: new Date("2020-01-01T00:00:00.000Z"),
    channels: { cache: channelCache },
    roles: { cache: roleCache },
    members: {
      cache: memberCache,
      fetch: async (arg: string | { query: string; limit: number }) => {
        if (typeof arg === "string") {
          const found = memberCache.get(arg);
          if (!found) throw new Error("Unknown Member");
          return found;
        }
        const matches = opts.fetchByQuery?.(arg.query) ?? [];
        const result = new Collection<string, unknown>();
        for (const m of matches) result.set(m.id, m);
        return result;
      },
    },
  };
}

interface FakeClientOptions {
  guilds?: Record<string, unknown>;
  channels?: Record<string, unknown>;
  /** Thrown by channels.fetch for any id not in `channels`. */
  fetchThrows?: boolean;
}

function fakeClient(opts: FakeClientOptions = {}): Client {
  const guildCache = new Collection<string, unknown>();
  for (const [id, guild] of Object.entries(opts.guilds ?? {})) {
    guildCache.set(id, guild);
  }
  return {
    guilds: { cache: guildCache },
    channels: {
      fetch: async (id: string) => {
        const channel = opts.channels?.[id];
        if (channel === undefined) {
          if (opts.fetchThrows) throw new Error(`Unknown Channel ${id}`);
          return null;
        }
        return channel;
      },
    },
  } as unknown as Client;
}

function textChannel(messages: ReturnType<typeof fakeMessage>[]) {
  const cache = new Collection<string, unknown>();
  for (const m of messages) cache.set(m.id, m);
  return {
    isTextBased: () => true,
    isSendable: () => true,
    messages: {
      fetch: async (arg: { limit: number } | string) => {
        if (typeof arg === "string") {
          const found = cache.get(arg);
          if (!found) throw new Error("Unknown Message");
          return found;
        }
        const limited = new Collection<string, unknown>();
        for (const [key, value] of cache) {
          if (limited.size >= arg.limit) break;
          limited.set(key, value);
        }
        return limited;
      },
    },
  };
}

function ctx(client: Client, overrides: Record<string, unknown> = {}) {
  return {
    client,
    guildId: "guild-1",
    channelId: "chan-1",
    userId: "user-1",
    ...overrides,
  } as import("../../../src/ai/tools/discord.js").DiscordToolContext;
}

// get_server_info

test("get_server_info summarizes the guild, its channels and its roles", async () => {
  const guild = fakeGuild("guild-1", {
    members: [fakeMember("owner-1", { displayName: "The Owner" })],
  });
  const tools = createDiscordTools(
    ctx(fakeClient({ guilds: { "guild-1": guild } }))
  );

  const info = (await tools.get_server_info.execute?.({}, toolOpts)) as {
    name: string;
    memberCount: number;
    owner: string;
    createdAt: string;
    channels: Array<{ name: string; type: string; category?: string }>;
    roles: Array<{ name: string; memberCount: number }>;
  };

  assert.equal(info.name, "Test Guild");
  assert.equal(info.memberCount, 42);
  assert.equal(info.owner, "The Owner");
  assert.equal(info.createdAt, "2020-01-01T00:00:00.000Z");

  const general = info.channels.find((c) => c.name === "general");
  assert.equal(general?.type, "GuildText");
  assert.equal(general?.category, "Text Channels");
  // a top-level channel carries no category key at all
  const category = info.channels.find((c) => c.name === "Text Channels");
  assert.ok(category && !("category" in category));

  // @everyone is stripped and the rest come highest-first
  assert.deepEqual(
    info.roles.map((r) => r.name),
    ["Moderator", "Member"]
  );
  assert.equal(info.roles[0]?.memberCount, 1);
});

test("get_server_info falls back to the owner id when they are not cached", async () => {
  const guild = fakeGuild("guild-1");
  const tools = createDiscordTools(
    ctx(fakeClient({ guilds: { "guild-1": guild } }))
  );
  const info = (await tools.get_server_info.execute?.({}, toolOpts)) as {
    owner: string;
  };
  assert.equal(info.owner, "owner-1");
});

test("the guild tools report a DM context instead of guessing", async () => {
  const tools = createDiscordTools(ctx(fakeClient(), { guildId: null }));
  const expected = { error: "Not in a server (DM context)." };
  assert.deepEqual(
    await tools.get_server_info.execute?.({}, toolOpts),
    expected
  );
  assert.deepEqual(
    await tools.get_user_info.execute?.({ query: "anyone" }, toolOpts),
    expected
  );
});

test("a guild id the client has not cached is treated as no guild", async () => {
  // the bot was removed from the guild, or the cache is cold
  const tools = createDiscordTools(ctx(fakeClient(), { guildId: "gone" }));
  assert.deepEqual(await tools.get_server_info.execute?.({}, toolOpts), {
    error: "Not in a server (DM context).",
  });
});

// get_user_info

test("get_user_info resolves a snowflake directly", async () => {
  const member = fakeMember("123456789012345678", {
    username: "ada",
    displayName: "Ada L.",
    roles: ["Moderator"],
  });
  const guild = fakeGuild("guild-1", { members: [member] });
  const tools = createDiscordTools(
    ctx(fakeClient({ guilds: { "guild-1": guild } }))
  );

  const result = await tools.get_user_info.execute?.(
    { query: "123456789012345678" },
    toolOpts
  );
  assert.deepEqual(result, {
    id: "123456789012345678",
    username: "ada",
    displayName: "Ada L.",
    bot: false,
    // @everyone never shows up in the formatted roles
    roles: ["Moderator"],
    joinedAt: "2024-03-01T12:00:00.000Z",
  });
});

test("an id that is not a member falls through to the name search", async () => {
  const member = fakeMember("999999999999999999", { username: "grace" });
  const guild = fakeGuild("guild-1", {
    // the ID lookup rejects; the query search finds someone anyway
    fetchByQuery: () => [member],
  });
  const tools = createDiscordTools(
    ctx(fakeClient({ guilds: { "guild-1": guild } }))
  );

  const result = (await tools.get_user_info.execute?.(
    { query: "111111111111111111" },
    toolOpts
  )) as { username: string };
  assert.equal(result.username, "grace");
});

test("get_user_info returns every match when a name is ambiguous", async () => {
  const guild = fakeGuild("guild-1", {
    fetchByQuery: () => [
      fakeMember("a", { username: "sam1" }),
      fakeMember("b", { username: "sam2", bot: true, joinedAt: null }),
    ],
  });
  const tools = createDiscordTools(
    ctx(fakeClient({ guilds: { "guild-1": guild } }))
  );

  const result = (await tools.get_user_info.execute?.(
    { query: "sam" },
    toolOpts
  )) as {
    matches: Array<{ username: string; bot: boolean; joinedAt: string | null }>;
    hint: string;
  };
  assert.deepEqual(
    result.matches.map((m) => m.username),
    ["sam1", "sam2"]
  );
  assert.equal(result.matches[1]?.bot, true);
  assert.equal(result.matches[1]?.joinedAt, null);
  assert.match(result.hint, /Multiple matches/);
});

test("get_user_info says so when nothing matches", async () => {
  const guild = fakeGuild("guild-1", { fetchByQuery: () => [] });
  const tools = createDiscordTools(
    ctx(fakeClient({ guilds: { "guild-1": guild } }))
  );
  assert.deepEqual(
    await tools.get_user_info.execute?.({ query: "nobody" }, toolOpts),
    { error: 'No member found matching "nobody".' }
  );
});

// get_channel_messages

test("get_channel_messages reads the current channel oldest-first by default", async () => {
  const channel = textChannel([
    fakeMessage("m-newest", { content: "third" }),
    fakeMessage("m-mid", { content: "second" }),
    fakeMessage("m-oldest", { content: "first" }),
  ]);
  const tools = createDiscordTools(
    ctx(fakeClient({ channels: { "chan-1": channel } }))
  );

  const result = (await tools.get_channel_messages.execute?.(
    { channelId: null, limit: null },
    toolOpts
  )) as Array<{ id: string; content: string | null; timestamp: string }>;

  // Discord hands them back newest-first; the tool reverses into reading order
  assert.deepEqual(
    result.map((m) => m.id),
    ["m-oldest", "m-mid", "m-newest"]
  );
  assert.equal(result[0]?.content, "first");
  assert.equal(result[0]?.timestamp, "2024-05-05T00:00:00.000Z");
});

test("get_channel_messages honours an explicit channel and limit", async () => {
  const channel = textChannel([
    fakeMessage("a"),
    fakeMessage("b"),
    fakeMessage("c"),
  ]);
  const tools = createDiscordTools(
    ctx(fakeClient({ channels: { other: channel } }))
  );
  const result = (await tools.get_channel_messages.execute?.(
    { channelId: "other", limit: 2 },
    toolOpts
  )) as unknown[];
  assert.equal(result.length, 2);
});

test("get_channel_messages surfaces embeds and attachments, and blanks empty content", async () => {
  const channel = textChannel([
    fakeMessage("rich", {
      content: "",
      embeds: [{ title: "Release notes" }, { description: "details" }, {}],
      attachments: ["https://cdn.example/file.png"],
    }),
  ]);
  const tools = createDiscordTools(
    ctx(fakeClient({ channels: { "chan-1": channel } }))
  );

  const [message] = (await tools.get_channel_messages.execute?.(
    { channelId: null, limit: null },
    toolOpts
  )) as Array<{
    content: string | null;
    embeds?: string[];
    attachments?: string[];
  }>;

  assert.equal(message?.content, null);
  assert.deepEqual(message?.embeds, ["Release notes", "details", "(embed)"]);
  assert.deepEqual(message?.attachments, ["https://cdn.example/file.png"]);
});

test("get_channel_messages omits embed and attachment keys when there are none", async () => {
  const channel = textChannel([fakeMessage("plain")]);
  const tools = createDiscordTools(
    ctx(fakeClient({ channels: { "chan-1": channel } }))
  );
  const [message] = (await tools.get_channel_messages.execute?.(
    { channelId: null, limit: null },
    toolOpts
  )) as Array<Record<string, unknown>>;
  assert.equal(message?.embeds, undefined);
  assert.equal(message?.attachments, undefined);
});

test("get_channel_messages distinguishes a failed fetch from a non-text channel", async () => {
  const throwing = createDiscordTools(
    ctx(fakeClient({ fetchThrows: true }), { channelId: "missing" })
  );
  assert.deepEqual(
    await throwing.get_channel_messages.execute?.(
      { channelId: null, limit: null },
      toolOpts
    ),
    { error: "Could not fetch channel missing." }
  );

  const voice = createDiscordTools(
    ctx(fakeClient({ channels: { "chan-1": { isTextBased: () => false } } }))
  );
  assert.deepEqual(
    await voice.get_channel_messages.execute?.(
      { channelId: null, limit: null },
      toolOpts
    ),
    { error: "Channel is not a text channel." }
  );
});

// react_to_message

test("react_to_message adds the emoji to the target message", async () => {
  const reactions: string[] = [];
  const message = fakeMessage("m-1", {
    react: async (emoji: string) => {
      reactions.push(emoji);
    },
  });
  const tools = createDiscordTools(
    ctx(fakeClient({ channels: { "chan-1": textChannel([message]) } }))
  );

  assert.deepEqual(
    await tools.react_to_message.execute?.(
      { messageId: "m-1", emoji: "👍", channelId: null },
      toolOpts
    ),
    { success: true }
  );
  assert.deepEqual(reactions, ["👍"]);
});

test("react_to_message reports a non-text channel and a failed reaction", async () => {
  const voice = createDiscordTools(
    ctx(fakeClient({ channels: { "chan-1": { isTextBased: () => false } } }))
  );
  assert.deepEqual(
    await voice.react_to_message.execute?.(
      { messageId: "m-1", emoji: "👍", channelId: null },
      toolOpts
    ),
    { error: "Not a text channel." }
  );

  const failing = fakeMessage("m-1", {
    react: async () => {
      throw new Error("Missing Permissions");
    },
  });
  const tools = createDiscordTools(
    ctx(fakeClient({ channels: { "chan-1": textChannel([failing]) } }))
  );
  assert.deepEqual(
    await tools.react_to_message.execute?.(
      { messageId: "m-1", emoji: "👍", channelId: null },
      toolOpts
    ),
    { error: "Failed to react: Missing Permissions" }
  );
});

test("react_to_message reports a message it cannot fetch", async () => {
  const tools = createDiscordTools(
    ctx(fakeClient({ channels: { "chan-1": textChannel([]) } }))
  );
  const result = (await tools.react_to_message.execute?.(
    { messageId: "nope", emoji: "👍", channelId: null },
    toolOpts
  )) as { error: string };
  assert.match(result.error, /^Failed to react: Unknown Message$/);
});

// send_message

test("send_message posts to another channel and returns the new message id", async () => {
  const sent: unknown[] = [];
  const target = {
    isSendable: () => true,
    send: async (payload: unknown) => {
      sent.push(payload);
      return { id: "posted-1" };
    },
  };
  const tools = createDiscordTools(
    ctx(fakeClient({ channels: { "chan-2": target } }))
  );

  assert.deepEqual(
    await tools.send_message.execute?.(
      { channelId: "chan-2", content: "**heads up**" },
      toolOpts
    ),
    { success: true, messageId: "posted-1" }
  );
  assert.equal(sent.length, 1);
  const payload = sent[0] as { components: unknown[] };
  assert.ok(
    payload.components.length > 0,
    "markdown should be rendered into components"
  );
});

test("send_message refuses to double up on the current channel", async () => {
  const tools = createDiscordTools(ctx(fakeClient()));
  const result = (await tools.send_message.execute?.(
    { channelId: "chan-1", content: "hello" },
    toolOpts
  )) as { error: string };
  assert.match(result.error, /Use your normal reply for the current channel/);
});

test("send_message reports an unsendable channel and a rejected send", async () => {
  const unsendable = createDiscordTools(
    ctx(fakeClient({ channels: { "chan-2": { isSendable: () => false } } }))
  );
  assert.deepEqual(
    await unsendable.send_message.execute?.(
      { channelId: "chan-2", content: "hello" },
      toolOpts
    ),
    { error: "Cannot send messages to this channel." }
  );

  const rejecting = createDiscordTools(
    ctx(
      fakeClient({
        channels: {
          "chan-2": {
            isSendable: () => true,
            send: async () => {
              throw new Error("Missing Access");
            },
          },
        },
      })
    )
  );
  assert.deepEqual(
    await rejecting.send_message.execute?.(
      { channelId: "chan-2", content: "hello" },
      toolOpts
    ),
    { error: "Failed to send: Missing Access" }
  );
});

test("send_message treats an unknown channel as unsendable", async () => {
  // channels.fetch resolves to null for a channel the bot cannot see
  const tools = createDiscordTools(ctx(fakeClient()));
  assert.deepEqual(
    await tools.send_message.execute?.(
      { channelId: "chan-unknown", content: "hello" },
      toolOpts
    ),
    { error: "Cannot send messages to this channel." }
  );
});
