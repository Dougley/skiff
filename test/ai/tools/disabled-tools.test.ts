import assert from "node:assert/strict";
import type { MCPClient } from "@ai-sdk/mcp";
import type { Client } from "discord.js";
import { test } from "vitest";
import { bootstrapTestEnv, MISSING_MCP_CONFIG } from "../../helpers/setup.js";

bootstrapTestEnv();
process.env.MCP_CONFIG_PATH = MISSING_MCP_CONFIG;

const { env } = await import("../../../src/config/env.js");
const { initAccessConfig, parseAccessConfig } = await import(
  "../../../src/config/access.js"
);
const { createToolSet } = await import("../../../src/ai/tools/toolset.js");

const toolContext = {
  client: {} as Client,
  guildId: "guild-1",
  channelId: "channel-1",
  userId: "user-1",
};

/** Builds a tool set under the given DISABLED_TOOLS value. */
async function toolNames(disabled: string): Promise<string[]> {
  env.DISABLED_TOOLS = disabled;
  initAccessConfig(env);
  const openClients: MCPClient[] = [];
  const tools = await createToolSet(toolContext, {}, openClients);
  await Promise.allSettled(openClients.map((c) => c.close()));
  return Object.keys(tools);
}

test("an empty DISABLED_TOOLS disables nothing", async () => {
  const config = parseAccessConfig({ ...env, DISABLED_TOOLS: "" });
  assert.equal(config.disabledToolGroups.size, 0);
  assert.equal(config.disabledToolNames.size, 0);

  const names = await toolNames("");
  assert.ok(names.includes("web_search"));
  assert.ok(names.includes("fetch_url"));
});

test("entries split into known groups and everything else as tool names", () => {
  const config = parseAccessConfig({
    ...env,
    DISABLED_TOOLS: " web_search , shell ,, memory_search ",
  });
  assert.deepEqual([...config.disabledToolGroups], ["shell"]);
  assert.deepEqual(
    [...config.disabledToolNames],
    ["web_search", "memory_search"]
  );
});

test("naming one tool drops it without touching the rest of its group", async () => {
  const names = await toolNames("web_search");
  assert.ok(!names.includes("web_search"));
  // fetch_url and browser_cdp are the same `web` group — replacing search
  // shouldn't cost you page fetching
  assert.ok(names.includes("fetch_url"));
});

test("naming a group drops the whole group, everywhere", async () => {
  const names = await toolNames("web");
  assert.ok(!names.includes("web_search"));
  assert.ok(!names.includes("fetch_url"));
  assert.ok(names.includes("memory_search"));
});

test("a global rule applies to autonomous turns, which have no user to scope by", async () => {
  env.DISABLED_TOOLS = "web_search";
  initAccessConfig(env);
  const openClients: MCPClient[] = [];
  const tools = await createToolSet(
    { ...toolContext, userId: null, guildId: null },
    {},
    openClients
  );
  await Promise.allSettled(openClients.map((c) => c.close()));
  assert.ok(!Object.keys(tools).includes("web_search"));
});

test("an unrecognised name is inert", async () => {
  const names = await toolNames("not_a_real_tool");
  assert.ok(names.includes("web_search"));
});

// the replacement-MCP-tool case lives in disabled-tools-mcp.test.ts: MCP
// clients are created once at import, so the config has to be in place before
// anything pulls the module in — that needs its own process.
