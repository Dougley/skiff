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
const { db, topicKnowledge } = await import("../../../src/db/index.js");
const { eq } = await import("drizzle-orm");
const { env } = await import("../../../src/config/env.js");
const { TopicCommand } = await import("../../../src/discord/commands/topic.js");

const command = new TopicCommand(loaderContext("topic"), {});

beforeAll(async () => {
  await runMigrations();
});

afterEach(() => {
  env.GUILD_ID = undefined;
});

/** Seeds topics oldest-first; `/topic list` renders them newest-first. */
async function seedTopics(
  scope: { guildId?: string | null; channelId?: string | null },
  topics: { title: string; summary: string; tags?: string[] }[]
): Promise<number[]> {
  const ids: number[] = [];
  let tick = 0;
  for (const topic of topics) {
    const [row] = await db
      .insert(topicKnowledge)
      .values({
        title: topic.title,
        summary: topic.summary,
        tags: topic.tags ?? [],
        guildId: scope.guildId ?? null,
        channelId: scope.channelId ?? null,
        updatedAt: new Date(Date.now() + tick++ * 1000),
      })
      .returning({ id: topicKnowledge.id });
    if (row) ids.push(row.id);
  }
  return ids;
}

const isActive = async (id: number) =>
  (
    await db
      .select({ active: topicKnowledge.active })
      .from(topicKnowledge)
      .where(eq(topicKnowledge.id, id))
  )[0]?.active;

// registration

test("registers list, forget and forget-all globally", () => {
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(chatInput.length, 1);
  const json = chatInput[0]?.builder.toJSON();
  assert.equal(json?.name, "topic");
  assert.deepEqual(
    json?.options?.map((o) => o.name),
    ["list", "forget", "forget-all"]
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

// list

test("list says so when nothing is stored in this scope", async () => {
  const interaction = makeInteraction({
    guildId: "guild-empty",
    options: { subcommand: "list" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(interaction.deferReply.mock.calls.length, 1);
  assert.equal(lastReplyText(interaction), "No topic knowledge stored yet.");
});

test("list renders titles, tags and a truncated summary newest-first", async () => {
  await seedTopics({ guildId: "guild-list" }, [
    { title: "Older topic", summary: "short summary" },
    {
      title: "Newer topic",
      summary: "y".repeat(150),
      tags: ["alpha", "beta"],
    },
  ]);
  const interaction = makeInteraction({
    guildId: "guild-list",
    options: { subcommand: "list" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    [
      "Stored topics (2):",
      "",
      `**1.** Newer topic [alpha, beta]\n> ${"y".repeat(100)}…`,
      "",
      "**2.** Older topic\n> short summary",
      "",
      "-# Use `/topic forget <number>` to remove a topic.",
    ].join("\n")
  );
});

test("list only sees the current DM channel plus legacy global rows", async () => {
  await seedTopics({ channelId: "dm-mine" }, [
    { title: "Mine", summary: "in this DM" },
  ]);
  await seedTopics({ channelId: "dm-theirs" }, [
    { title: "Theirs", summary: "another DM" },
  ]);
  await seedTopics({}, [{ title: "Legacy", summary: "no scope at all" }]);
  const interaction = makeInteraction({
    guildId: null,
    channelId: "dm-mine",
    options: { subcommand: "list" },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.match(reply, /Mine/);
  assert.match(reply, /Legacy/);
  assert.ok(!reply.includes("Theirs"));
});

test("list truncates a reply that would exceed Discord's limit", async () => {
  await seedTopics(
    { guildId: "guild-long" },
    Array.from({ length: 30 }, (_, i) => ({
      title: `Topic ${i} ${"t".repeat(60)}`,
      summary: "z".repeat(120),
    }))
  );
  const interaction = makeInteraction({
    guildId: "guild-long",
    options: { subcommand: "list" },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.equal(reply.length, 1998);
  assert.ok(reply.endsWith("…"));
});

// forget

test("forget deactivates the numbered topic", async () => {
  const [older, newer] = await seedTopics({ guildId: "guild-forget" }, [
    { title: "Older", summary: "a" },
    { title: "Newer", summary: "b" },
  ]);
  const interaction = makeInteraction({
    guildId: "guild-forget",
    options: { subcommand: "forget", integers: { number: 1 } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(lastReplyText(interaction), "Forgotten: *Newer*");
  assert.equal(await isActive(newer as number), false);
  assert.equal(await isActive(older as number), true);
});

test("forget rejects a number past the end of the list", async () => {
  await seedTopics({ guildId: "guild-oob" }, [{ title: "Only", summary: "a" }]);
  const interaction = makeInteraction({
    guildId: "guild-oob",
    options: { subcommand: "forget", integers: { number: 9 } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    "Invalid number. You have 1 topic. Use `/topic list` to see them."
  );
});

test("forget pluralises the count when the scope is empty", async () => {
  const interaction = makeInteraction({
    guildId: "guild-forget-empty",
    options: { subcommand: "forget", integers: { number: 1 } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    "Invalid number. You have 0 topics. Use `/topic list` to see them."
  );
});

// forget-all

test("forget-all deactivates every topic in scope", async () => {
  const ids = await seedTopics({ guildId: "guild-all" }, [
    { title: "One", summary: "a" },
    { title: "Two", summary: "b" },
  ]);
  const interaction = makeInteraction({
    guildId: "guild-all",
    options: { subcommand: "forget-all" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(lastReplyText(interaction), "Done — forgot 2 topics.");
  for (const id of ids) assert.equal(await isActive(id), false);
});

test("forget-all uses the singular for a single topic", async () => {
  await seedTopics({ guildId: "guild-one" }, [{ title: "One", summary: "a" }]);
  const interaction = makeInteraction({
    guildId: "guild-one",
    options: { subcommand: "forget-all" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(lastReplyText(interaction), "Done — forgot 1 topic.");
});

test("forget-all says so when the scope holds nothing", async () => {
  const interaction = makeInteraction({
    guildId: "guild-forget-all-empty",
    options: { subcommand: "forget-all" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(lastReplyText(interaction), "No topic knowledge stored.");
});

test("an unknown subcommand is a no-op", async () => {
  const interaction = makeInteraction({ options: { subcommand: "bogus" } });

  await command.chatInputRun(interaction as never);

  assert.equal(interaction.deferReply.mock.calls.length, 0);
  assert.equal(interaction.editReply.mock.calls.length, 0);
});
