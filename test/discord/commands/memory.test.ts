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
const { db, userFacts } = await import("../../../src/db/index.js");
const { and, eq } = await import("drizzle-orm");
const { env } = await import("../../../src/config/env.js");
const { MemoryCommand } = await import(
  "../../../src/discord/commands/memory.js"
);

const command = new MemoryCommand(loaderContext("memory"), {});

beforeAll(async () => {
  await runMigrations();
});

afterEach(() => {
  env.GUILD_ID = undefined;
});

/**
 * Inserts facts newest-last; `/memory list` orders by updatedAt desc, so the
 * returned ids are reversed to match the numbering the user sees.
 */
async function seedFacts(
  userId: string,
  scope: { guildId?: string | null; channelId?: string | null },
  facts: { fact: string; category?: string | null }[]
): Promise<number[]> {
  const ids: number[] = [];
  let tick = 0;
  for (const entry of facts) {
    const [row] = await db
      .insert(userFacts)
      .values({
        userId,
        guildId: scope.guildId ?? null,
        channelId: scope.channelId ?? null,
        fact: entry.fact,
        category: entry.category ?? null,
        updatedAt: new Date(Date.now() + tick++ * 1000),
      })
      .returning({ id: userFacts.id });
    if (row) ids.push(row.id);
  }
  return ids.reverse();
}

const activeFacts = (userId: string) =>
  db
    .select({ id: userFacts.id, fact: userFacts.fact })
    .from(userFacts)
    .where(and(eq(userFacts.userId, userId), eq(userFacts.active, true)));

// registration

test("registers list, forget and forget-all globally", () => {
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(chatInput.length, 1);
  const json = chatInput[0]?.builder.toJSON();
  assert.equal(json?.name, "memory");
  assert.deepEqual(
    json?.options?.map((o) => o.name),
    ["list", "forget", "forget-all"]
  );
  assert.equal(json?.integration_types?.length, 2);
  assert.equal(json?.contexts?.length, 3);
});

test("adds a guild-scoped registration when GUILD_ID is set", () => {
  env.GUILD_ID = "guild-42";
  const { chatInput, registry } = stubRegistry();
  command.registerApplicationCommands(registry);

  assert.equal(chatInput.length, 2);
  assert.deepEqual(chatInput[0]?.options, { guildIds: ["guild-42"] });
});

// list

test("list says nothing is stored when the user has no facts", async () => {
  const interaction = makeInteraction({
    user: { id: "user-empty", username: "u", displayName: "U" },
    options: { subcommand: "list" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(interaction.deferReply.mock.calls.length, 1);
  assert.equal(
    lastReplyText(interaction),
    "I don't have any facts stored about you."
  );
});

test("list numbers facts newest-first and shows categories", async () => {
  await seedFacts("user-list", { guildId: "guild-1" }, [
    { fact: "likes tea", category: "preference" },
    { fact: "lives in Delft" },
  ]);
  const interaction = makeInteraction({
    user: { id: "user-list", username: "u", displayName: "U" },
    guildId: "guild-1",
    options: { subcommand: "list" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    [
      "Here's what I remember about you:",
      "",
      "**1.** lives in Delft",
      "**2.** likes tea [preference]",
      "",
      "-# Use `/memory forget <number>` to remove a fact.",
    ].join("\n")
  );
});

test("list keeps facts from another guild out of scope", async () => {
  await seedFacts("user-scope", { guildId: "guild-a" }, [
    { fact: "guild-a fact" },
  ]);
  await seedFacts("user-scope", {}, [{ fact: "global fact" }]);
  const interaction = makeInteraction({
    user: { id: "user-scope", username: "u", displayName: "U" },
    guildId: "guild-b",
    options: { subcommand: "list" },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.match(reply, /global fact/);
  assert.ok(!reply.includes("guild-a fact"));
});

test("list truncates a reply that would exceed Discord's limit", async () => {
  await seedFacts(
    "user-long",
    { guildId: "guild-long" },
    Array.from({ length: 40 }, (_, i) => ({ fact: `${"x".repeat(80)}-${i}` }))
  );
  const interaction = makeInteraction({
    user: { id: "user-long", username: "u", displayName: "U" },
    guildId: "guild-long",
    options: { subcommand: "list" },
  });

  await command.chatInputRun(interaction as never);

  const reply = lastReplyText(interaction);
  assert.ok(reply.length <= 2000, `reply was ${reply.length} chars`);
  assert.match(
    reply,
    /…\n\n-# Use `\/memory forget <number>` to remove a fact\.$/
  );
});

// forget

test("forget deactivates the numbered fact only", async () => {
  const [newest] = await seedFacts("user-forget", { guildId: "guild-f" }, [
    { fact: "older fact" },
    { fact: "newer fact" },
  ]);
  const interaction = makeInteraction({
    user: { id: "user-forget", username: "u", displayName: "U" },
    guildId: "guild-f",
    options: { subcommand: "forget", integers: { number: 1 } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(lastReplyText(interaction), "Forgotten: *newer fact*");
  const remaining = await activeFacts("user-forget");
  assert.deepEqual(
    remaining.map((row) => row.fact),
    ["older fact"]
  );
  assert.ok(!remaining.some((row) => row.id === newest));
});

test("forget rejects a number past the end of the list", async () => {
  await seedFacts("user-oob", { guildId: "guild-oob" }, [{ fact: "only one" }]);
  const interaction = makeInteraction({
    user: { id: "user-oob", username: "u", displayName: "U" },
    guildId: "guild-oob",
    options: { subcommand: "forget", integers: { number: 4 } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    "Invalid number. You have 1 fact. Use `/memory list` to see them."
  );
  assert.equal((await activeFacts("user-oob")).length, 1);
});

test("forget pluralises the count when the user has no facts at all", async () => {
  const interaction = makeInteraction({
    user: { id: "user-none", username: "u", displayName: "U" },
    guildId: "guild-none",
    options: { subcommand: "forget", integers: { number: 1 } },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    "Invalid number. You have 0 facts. Use `/memory list` to see them."
  );
});

// forget-all

test("forget-all deactivates every in-scope fact and reports the count", async () => {
  await seedFacts("user-all", { guildId: "guild-all" }, [
    { fact: "one" },
    { fact: "two" },
  ]);
  const interaction = makeInteraction({
    user: { id: "user-all", username: "u", displayName: "U" },
    guildId: "guild-all",
    options: { subcommand: "forget-all" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(lastReplyText(interaction), "Done — forgot 2 facts about you.");
  assert.deepEqual(await activeFacts("user-all"), []);
});

test("forget-all uses the singular for one fact", async () => {
  await seedFacts("user-single", { channelId: "dm-single" }, [
    { fact: "just one" },
  ]);
  const interaction = makeInteraction({
    user: { id: "user-single", username: "u", displayName: "U" },
    guildId: null,
    channelId: "dm-single",
    options: { subcommand: "forget-all" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(lastReplyText(interaction), "Done — forgot 1 fact about you.");
});

test("forget-all says nothing was stored when there is nothing in scope", async () => {
  const interaction = makeInteraction({
    user: { id: "user-nothing", username: "u", displayName: "U" },
    guildId: "guild-nothing",
    options: { subcommand: "forget-all" },
  });

  await command.chatInputRun(interaction as never);

  assert.equal(
    lastReplyText(interaction),
    "I don't have any facts stored about you."
  );
});

test("an unknown subcommand is a no-op", async () => {
  const interaction = makeInteraction({ options: { subcommand: "bogus" } });

  await command.chatInputRun(interaction as never);

  assert.equal(interaction.deferReply.mock.calls.length, 0);
  assert.equal(interaction.editReply.mock.calls.length, 0);
});
