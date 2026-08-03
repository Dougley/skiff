import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, test } from "vitest";
import { bootstrapTestEnv } from "../helpers/setup.js";
import { captureLog } from "./listeners/fixtures.js";

bootstrapTestEnv();

const { ApplicationCommandRegistry, container } = await import(
  "@sapphire/framework"
);
const {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  SlashCommandBuilder,
} = await import("discord.js");
const {
  getIdHints,
  installIdHintInjection,
  loadIdHintStore,
  persistCommandIds,
} = await import("../../src/discord/command-id-hints.js");
const { commandIdHints, db } = await import("../../src/db/index.js");
const { runMigrations } = await import("../../src/db/migrate.js");
const { logger } = await import("../../src/config/logger.js");

const realStores = container.stores;
const realRegisterChatInput =
  ApplicationCommandRegistry.prototype.registerChatInputCommand;
const realRegisterContextMenu =
  ApplicationCommandRegistry.prototype.registerContextMenuCommand;

beforeAll(async () => {
  await runMigrations();
});

afterAll(() => {
  container.stores = realStores;
  ApplicationCommandRegistry.prototype.registerChatInputCommand =
    realRegisterChatInput;
  ApplicationCommandRegistry.prototype.registerContextMenuCommand =
    realRegisterContextMenu;
});

/** Stand in for the Sapphire command store: display name → declared hint key. */
function setCommandStore(entries: Record<string, string | undefined>) {
  const commands = new Map(
    Object.entries(entries).map(([name, idHintKey]) => [
      name,
      { options: idHintKey ? { idHintKey } : {} },
    ])
  );
  container.stores = new Map([["commands", commands]]) as never;
}

interface RegistryIds {
  global?: string[];
  globalContext?: string[];
  guildChat?: Record<string, string[]>;
  guildContext?: Record<string, string[]>;
}

type Registry = InstanceType<typeof ApplicationCommandRegistry>;

/** The registrations a registry queued, which Sapphire keeps private. */
type RecordedApiCall = {
  registerOptions: { idHints?: string[]; guildIds?: string[] };
};

const apiCallsOf = (registry: Registry): RecordedApiCall[] =>
  (registry as unknown as { apiCalls: RecordedApiCall[] }).apiCalls;

function fakeRegistry(ids: RegistryIds): Registry {
  const toCollection = (source: Record<string, string[]> = {}) =>
    new Map(
      Object.entries(source).map(([guildId, values]) => [
        guildId,
        new Set(values),
      ])
    );
  return {
    globalChatInputCommandIds: new Set(ids.global ?? []),
    globalContextMenuCommandIds: new Set(ids.globalContext ?? []),
    guildIdToChatInputCommandIds: toCollection(ids.guildChat),
    guildIdToContextMenuCommandIds: toCollection(ids.guildContext),
  } as unknown as Registry;
}

function persist(registries: Record<string, RegistryIds>) {
  return persistCommandIds(
    new Map(
      Object.entries(registries).map(([name, ids]) => [name, fakeRegistry(ids)])
    )
  );
}

async function storedIds(key: string): Promise<string[] | null> {
  const [row] = await db
    .select()
    .from(commandIdHints)
    .where(eq(commandIdHints.commandName, key));
  return row?.ids ?? null;
}

test("starts empty when nothing was ever persisted", async () => {
  await loadIdHintStore();
  assert.deepEqual(getIdHints("ask"), []);
});

test("persists ids from every scope under the command's hint key", async () => {
  setCommandStore({ ask: "ask" });
  const infoCalls = await captureLog(logger, "info", () =>
    persist({
      ask: {
        global: ["global-chat"],
        globalContext: ["global-ctx"],
        guildChat: { "guild-1": ["guild-chat"] },
        guildContext: { "guild-1": ["guild-ctx"] },
      },
    })
  );

  const expected = [
    "global-chat",
    "global-ctx",
    "guild-chat",
    "guild-ctx",
  ].sort();
  assert.deepEqual(getIdHints("ask"), expected);
  assert.deepEqual(await storedIds("ask"), expected);
  assert.match(String(infoCalls[0]?.[0]), /hints stored for \/ask/);
});

test("keeps hints keyed by idHintKey when the command is renamed", async () => {
  // same hint key, new display name — the stored ids must still resolve
  setCommandStore({ "ask-v2": "ask" });
  await persist({ "ask-v2": { global: ["renamed-id"] } });

  assert.ok(getIdHints("ask").includes("renamed-id"));
  assert.deepEqual(await storedIds("ask"), getIdHints("ask"));
  assert.deepEqual(getIdHints("ask-v2"), []);
});

test("skips the write when Discord assigned no new ids", async () => {
  setCommandStore({ ask: "ask" });
  const before = await storedIds("ask");
  const infoCalls = await captureLog(logger, "info", () =>
    persist({ ask: { global: ["global-chat"] }, quiet: {} })
  );

  assert.equal(infoCalls.length, 0);
  assert.deepEqual(await storedIds("ask"), before);
  assert.equal(await storedIds("quiet"), null);
});

test("refuses to store hints two commands claim at once", async () => {
  setCommandStore({ ask: "shared", "ask-alias": "shared" });
  const errorCalls = await captureLog(logger, "error", () =>
    persist({ ask: { global: ["x1"] }, "ask-alias": { global: ["x2"] } })
  );

  assert.equal(errorCalls.length, 2);
  assert.match(String(errorCalls[0]?.[0]), /claimed by multiple commands/);
  assert.deepEqual(getIdHints("shared"), []);
  assert.equal(await storedIds("shared"), null);
});

test("falls back to the command name when no idHintKey is declared", async () => {
  setCommandStore({ legacy: undefined });
  const debugCalls = await captureLog(logger, "debug", () =>
    persist({ legacy: { global: ["legacy-id"] } })
  );

  assert.deepEqual(getIdHints("legacy"), ["legacy-id"]);
  assert.ok(
    debugCalls.some((call) => /declares no idHintKey/.test(String(call[0])))
  );
});

test("falls back to the command name when no command store exists yet", async () => {
  container.stores = undefined as never;
  await persist({ storeless: { global: ["storeless-id"] } });

  assert.deepEqual(getIdHints("storeless"), ["storeless-id"]);
});

test("reloads the persisted hints from the database", async () => {
  await db
    .insert(commandIdHints)
    .values({ commandName: "reloaded", ids: ["r1", "r2"] });
  await db.delete(commandIdHints).where(eq(commandIdHints.commandName, "ask"));

  const debugCalls = await captureLog(logger, "debug", () => loadIdHintStore());

  assert.deepEqual(getIdHints("reloaded"), ["r1", "r2"]);
  assert.deepEqual(getIdHints("ask"), []);
  assert.ok(
    debugCalls.some((call) => /Command id hints loaded/.test(String(call[0])))
  );
});

test("continues without hints when the load query fails", async () => {
  const realSelect = db.select;
  (db as { select: unknown }).select = () => {
    throw new Error("connection lost");
  };
  const warnCalls = await captureLog(logger, "warn", () => loadIdHintStore());
  (db as { select: unknown }).select = realSelect;

  assert.match(String(warnCalls[0]?.[0]), /Failed to load command id hints/);
  // previously loaded hints survive the failure
  assert.deepEqual(getIdHints("reloaded"), ["r1", "r2"]);
});

test("keeps the in-memory hints when the write fails", async () => {
  setCommandStore({ flaky: "flaky" });
  const realInsert = db.insert;
  (db as { insert: unknown }).insert = () => {
    throw new Error("disk full");
  };
  const warnCalls = await captureLog(logger, "warn", () =>
    persist({ flaky: { global: ["flaky-id"] } })
  );
  (db as { insert: unknown }).insert = realInsert;

  assert.match(String(warnCalls[0]?.[0]), /Failed to persist command id hints/);
  assert.deepEqual(getIdHints("flaky"), ["flaky-id"]);
  assert.equal(await storedIds("flaky"), null);
});

test("injects stored hints into chat input registrations", () => {
  installIdHintInjection();
  setCommandStore({ reloaded: "reloaded" });

  const registry = new ApplicationCommandRegistry("reloaded");
  registry.registerChatInputCommand(
    new SlashCommandBuilder().setName("reloaded").setDescription("test")
  );

  const [call] = apiCallsOf(registry);
  assert.deepEqual(call?.registerOptions.idHints, ["r1", "r2"]);
});

test("merges explicitly provided hints and drops duplicates", () => {
  setCommandStore({ reloaded: "reloaded" });

  const registry = new ApplicationCommandRegistry("reloaded");
  registry.registerChatInputCommand(
    new SlashCommandBuilder().setName("reloaded").setDescription("test"),
    { idHints: ["manual", "r1"], guildIds: ["guild-1"] }
  );

  const [call] = apiCallsOf(registry);
  assert.deepEqual(call?.registerOptions.idHints, ["manual", "r1", "r2"]);
  assert.deepEqual(call?.registerOptions.guildIds, ["guild-1"]);
});

test("injects stored hints into context menu registrations", () => {
  setCommandStore({ "Ask Skiff": "reloaded" });

  const registry = new ApplicationCommandRegistry("Ask Skiff");
  registry.registerContextMenuCommand(
    new ContextMenuCommandBuilder()
      .setName("Ask Skiff")
      .setType(ApplicationCommandType.Message)
  );

  const [call] = apiCallsOf(registry);
  assert.deepEqual(call?.registerOptions.idHints, ["r1", "r2"]);
});

test("leaves registrations untouched when nothing is stored", () => {
  setCommandStore({ fresh: "fresh" });

  const registry = new ApplicationCommandRegistry("fresh");
  registry.registerChatInputCommand(
    new SlashCommandBuilder().setName("fresh").setDescription("test")
  );
  registry.registerContextMenuCommand(
    new ContextMenuCommandBuilder()
      .setName("Fresh")
      .setType(ApplicationCommandType.User)
  );

  for (const call of apiCallsOf(registry)) {
    assert.equal(call.registerOptions.idHints, undefined);
  }
});
