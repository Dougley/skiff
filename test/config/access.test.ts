import assert from "node:assert/strict";
import { beforeAll, test } from "vitest";
import { bootstrapTestEnv } from "../helpers/setup.js";

bootstrapTestEnv();

let access: typeof import("../../src/config/access.js");
let makeEnv: (
  overrides?: Record<string, string>
) => import("../../src/config/env-schema.js").EnvironmentVariables;

beforeAll(async () => {
  access = await import("../../src/config/access.js");
  const { environmentVariableSchema } = await import(
    "../../src/config/env-schema.js"
  );
  makeEnv = (overrides = {}) =>
    environmentVariableSchema.parse({
      DISCORD_BOT_TOKEN: `${Buffer.from("123456789012345678").toString("base64")}.test.signature`,
      ...overrides,
    });
});

test("getAccessConfig throws before initAccessConfig ran", () => {
  assert.throws(() => access.getAccessConfig(), /not initialized/);
});

test("initAccessConfig parses and caches the config", () => {
  const config = access.initAccessConfig(
    makeEnv({ ACCESS_ALLOWED_GUILDS: "g1, g2,,  " })
  );

  assert.equal(access.getAccessConfig(), config);
  assert.deepEqual([...config.allowedGuilds].sort(), ["g1", "g2"]);
});

test("parseAccessConfig splits DISABLED_TOOLS into groups and tool names", () => {
  const config = access.parseAccessConfig(
    makeEnv({ DISABLED_TOOLS: "web, shell ,web_search, not-a-group" })
  );

  assert.deepEqual([...config.disabledToolGroups].sort(), ["shell", "web"]);
  assert.deepEqual([...access.getDisabledToolNames(config)].sort(), [
    "not-a-group",
    "web_search",
  ]);
});

test("parseAccessConfig parses scoped tool rules and skips malformed entries", () => {
  const config = access.parseAccessConfig(
    makeEnv({
      TOOL_CHANNEL_RULES:
        "chan1: web , shell ; no-colon ; :orphan ; chan2:bogus ; chan3:memory ;;",
      TOOL_GUILD_RULES: "guild1:logbook",
      TOOL_USER_RULES: "user1:mcp,persona",
      TOOL_DM_RULES: " scheduler , nonsense ,topic",
    })
  );

  assert.deepEqual([...config.toolChannelRules.keys()].sort(), [
    "chan1",
    "chan3",
  ]);
  assert.deepEqual([...(config.toolChannelRules.get("chan1") ?? [])].sort(), [
    "shell",
    "web",
  ]);
  assert.deepEqual(
    [...(config.toolGuildRules.get("guild1") ?? [])],
    ["logbook"]
  );
  assert.deepEqual([...(config.toolUserRules.get("user1") ?? [])].sort(), [
    "mcp",
    "persona",
  ]);
  assert.deepEqual([...config.toolDmRules].sort(), ["scheduler", "topic"]);
});

test("empty rule strings produce empty structures", () => {
  const config = access.parseAccessConfig(makeEnv());

  assert.equal(config.toolChannelRules.size, 0);
  assert.equal(config.toolDmRules.size, 0);
  assert.equal(config.disabledToolGroups.size, 0);
  assert.equal(config.disabledToolNames.size, 0);
});

const dmCtx = {
  guildId: null,
  channelId: "dm-chan",
  userId: "u1",
  isDM: true,
};
const guildCtx = {
  guildId: "g1",
  channelId: "c1",
  userId: "u1",
  isDM: false,
};

test("checkAccess DM policies: open, disabled, allowlist", () => {
  assert.equal(
    access.checkAccess(dmCtx, access.parseAccessConfig(makeEnv())).allowed,
    true
  );

  const disabled = access.checkAccess(
    dmCtx,
    access.parseAccessConfig(makeEnv({ ACCESS_DM_POLICY: "disabled" }))
  );
  assert.equal(disabled.allowed, false);
  assert.equal(disabled.reason, "DMs are disabled");

  const allowlist = access.parseAccessConfig(
    makeEnv({ ACCESS_DM_POLICY: "allowlist", ACCESS_ALLOWED_USERS: "u1" })
  );
  assert.equal(access.checkAccess(dmCtx, allowlist).allowed, true);
  assert.deepEqual(
    access.checkAccess({ ...dmCtx, userId: "stranger" }, allowlist),
    { allowed: false, reason: "User not in DM allowlist" }
  );

  // an empty user allowlist means every DM user is allowed
  const emptyAllowlist = access.parseAccessConfig(
    makeEnv({ ACCESS_DM_POLICY: "allowlist" })
  );
  assert.equal(access.checkAccess(dmCtx, emptyAllowlist).allowed, true);
});

test("checkAccess guild policies: open, disabled, allowlist", () => {
  assert.equal(
    access.checkAccess(guildCtx, access.parseAccessConfig(makeEnv())).allowed,
    true
  );

  const disabled = access.checkAccess(
    guildCtx,
    access.parseAccessConfig(makeEnv({ ACCESS_POLICY: "disabled" }))
  );
  assert.deepEqual(disabled, { allowed: false, reason: "Bot is disabled" });

  const config = access.parseAccessConfig(
    makeEnv({
      ACCESS_POLICY: "allowlist",
      ACCESS_ALLOWED_GUILDS: "g1",
      ACCESS_ALLOWED_CHANNELS: "c1",
      ACCESS_ALLOWED_USERS: "u1",
    })
  );
  assert.equal(access.checkAccess(guildCtx, config).allowed, true);
  assert.deepEqual(access.checkAccess({ ...guildCtx, guildId: "g2" }, config), {
    allowed: false,
    reason: "Guild not in allowlist",
  });
  assert.deepEqual(access.checkAccess({ ...guildCtx, guildId: null }, config), {
    allowed: false,
    reason: "Guild not in allowlist",
  });
  assert.deepEqual(
    access.checkAccess({ ...guildCtx, channelId: "c2" }, config),
    { allowed: false, reason: "Channel not in allowlist" }
  );
  assert.deepEqual(access.checkAccess({ ...guildCtx, userId: "u2" }, config), {
    allowed: false,
    reason: "User not in allowlist",
  });

  // empty allowlists skip their respective checks
  const openLists = access.parseAccessConfig(
    makeEnv({ ACCESS_POLICY: "allowlist" })
  );
  assert.equal(access.checkAccess(guildCtx, openLists).allowed, true);
});

test("getDisabledToolGroups unions global, DM, guild, channel, and user rules", () => {
  const config = access.parseAccessConfig(
    makeEnv({
      DISABLED_TOOLS: "heartbeat",
      TOOL_DM_RULES: "web",
      TOOL_GUILD_RULES: "g1:shell",
      TOOL_CHANNEL_RULES: "c1:memory",
      TOOL_USER_RULES: "u1:persona",
    })
  );

  const inGuild = access.getDisabledToolGroups(
    { guildId: "g1", channelId: "c1", userId: "u1", isDM: false },
    config
  );
  assert.deepEqual([...inGuild].sort(), [
    "heartbeat",
    "memory",
    "persona",
    "shell",
  ]);

  const inDm = access.getDisabledToolGroups(
    { guildId: null, channelId: "dm-chan", userId: null, isDM: true },
    config
  );
  assert.deepEqual([...inDm].sort(), ["heartbeat", "web"]);

  // contexts matching no scoped rules still inherit the global set
  const elsewhere = access.getDisabledToolGroups(
    { guildId: "g2", channelId: "c9", userId: "u9", isDM: false },
    config
  );
  assert.deepEqual([...elsewhere], ["heartbeat"]);
});
