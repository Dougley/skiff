import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { MCPClient } from "@ai-sdk/mcp";
import type { Client } from "discord.js";

process.env.DISCORD_BOT_TOKEN = `${Buffer.from("123456789012345678").toString("base64")}.test.signature`;
process.env.OPENAI_API_KEY = "test";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.DATABASE_URL = "memory://";
// MCP clients are created once when the module is imported, so this has to be
// set before the dynamic imports below — hence a file of its own.
process.env.MCP_CONFIG_PATH = "test/fixtures/mcp-search.json";

const { env } = await import("../src/config/env.js");
const { initAccessConfig } = await import("../src/config/access.js");
const { createToolSet } = await import("../src/ai/tools/toolset.js");
const { closeMCPClients } = await import("../src/ai/tools/mcp.js");

after(() => closeMCPClients());

const toolContext = {
  client: {} as Client,
  guildId: "guild-1",
  channelId: "channel-1",
  userId: "user-1",
};

async function toolNames(disabled: string): Promise<string[]> {
  env.DISABLED_TOOLS = disabled;
  initAccessConfig(env);
  const openClients: MCPClient[] = [];
  const tools = await createToolSet(toolContext, {}, openClients);
  await Promise.allSettled(openClients.map((c) => c.close()));
  return Object.keys(tools);
}

test("an MCP tool is pushed aside while a built-in holds its name", async () => {
  const names = await toolNames("");
  assert.ok(names.includes("web_search"));
  assert.ok(
    names.includes("mcp_web_search"),
    "two search tools — the situation worth avoiding"
  );
});

test("disabling the built-in hands its name to the replacement", async () => {
  const names = await toolNames("web_search");
  // exactly one search tool, under the name the model already knows
  assert.ok(names.includes("web_search"));
  assert.ok(!names.includes("mcp_web_search"));
  // and the rest of the web group is untouched
  assert.ok(names.includes("fetch_url"));
});

test("the list names built-ins, so MCP keeps whatever mcp.json gave it", async () => {
  const names = await toolNames("fetch_url");
  assert.ok(!names.includes("fetch_url"));
  // the built-in web_search is still registered, so the MCP one stays prefixed
  assert.ok(names.includes("web_search"));
  assert.ok(names.includes("mcp_web_search"));
});

test("the mcp group is how you turn MCP tools off", async () => {
  const names = await toolNames("mcp");
  assert.ok(!names.includes("mcp_web_search"));
  assert.ok(names.includes("web_search"));
});
