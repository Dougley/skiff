import assert from "node:assert/strict";
import type { Client } from "discord.js";
import { beforeAll, test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { createHeartbeatTools } = await import(
  "../../../src/ai/tools/heartbeat.js"
);

const toolOpts = { toolCallId: "test-call", messages: [] } as never;

const guildCtx = {
  client: {} as Client,
  guildId: "hb-guild",
  channelId: "hb-channel",
  userId: "user-1",
};

const dmCtx = {
  client: {} as Client,
  guildId: null,
  channelId: "hb-dm-channel",
  userId: "user-1",
};

beforeAll(async () => {
  const { runMigrations } = await import("../../../src/db/migrate.js");
  await runMigrations();
});

test("heartbeat_status reports disabled for a channel that never enabled it", async () => {
  const tools = createHeartbeatTools(guildCtx);
  const status = await tools.heartbeat_status.execute?.({}, toolOpts);
  assert.deepEqual(status, {
    enabled: false,
    message: "Heartbeat is disabled for this channel.",
  });
});

test("enable_heartbeat turns monitoring on for the current channel only", async () => {
  const tools = createHeartbeatTools(guildCtx);
  const result = await tools.enable_heartbeat.execute?.({}, toolOpts);
  assert.equal((result as { success: boolean }).success, true);

  const status = await tools.heartbeat_status.execute?.({}, toolOpts);
  assert.equal((status as { enabled: boolean }).enabled, true);

  // another channel is unaffected
  const other = createHeartbeatTools({ ...guildCtx, channelId: "hb-other" });
  const otherStatus = await other.heartbeat_status.execute?.({}, toolOpts);
  assert.equal((otherStatus as { enabled: boolean }).enabled, false);
});

test("enable_heartbeat is idempotent (re-enabling an enabled channel)", async () => {
  const tools = createHeartbeatTools(guildCtx);
  await tools.enable_heartbeat.execute?.({}, toolOpts);
  const result = await tools.enable_heartbeat.execute?.({}, toolOpts);
  assert.equal((result as { success: boolean }).success, true);

  const status = await tools.heartbeat_status.execute?.({}, toolOpts);
  assert.equal((status as { enabled: boolean }).enabled, true);
});

test("disable_heartbeat turns monitoring back off", async () => {
  const tools = createHeartbeatTools(guildCtx);
  await tools.enable_heartbeat.execute?.({}, toolOpts);

  const result = await tools.disable_heartbeat.execute?.({}, toolOpts);
  assert.equal((result as { success: boolean }).success, true);

  const status = await tools.heartbeat_status.execute?.({}, toolOpts);
  assert.deepEqual(status, {
    enabled: false,
    message: "Heartbeat is disabled for this channel.",
  });
});

test("heartbeat works in DM contexts (null guild)", async () => {
  const tools = createHeartbeatTools(dmCtx);
  await tools.enable_heartbeat.execute?.({}, toolOpts);
  const status = await tools.heartbeat_status.execute?.({}, toolOpts);
  assert.equal((status as { enabled: boolean }).enabled, true);
});
