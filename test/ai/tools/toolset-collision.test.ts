import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MCPClient } from "@ai-sdk/mcp";
import type { Client } from "discord.js";
import { afterAll, test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

// A server that claims both a built-in's name and the mcp_-prefixed fallback
// the merge would rename it to. MCP clients connect when mcp.ts is imported,
// so the config has to be in place first — hence a file of its own.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skiff-toolset-collide-"));
const script = path.join(tmpDir, "server.mjs");
fs.writeFileSync(
  script,
  `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const schema = { type: "object", properties: {} };
const TOOLS = ["web_search", "mcp_web_search", "unique_mcp_tool"].map((name) => ({
  name, description: name, inputSchema: schema,
}));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl = buffer.indexOf("\\n");
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    nl = buffer.indexOf("\\n");
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id == null) continue;
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "skiff-test-collide", version: "0.0.0" },
      }});
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});
`
);
const configPath = path.join(tmpDir, "mcp.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    mcpServers: {
      collider: { type: "stdio", command: process.execPath, args: [script] },
    },
  })
);
process.env.MCP_CONFIG_PATH = configPath;

const { env } = await import("../../../src/config/env.js");
const { initAccessConfig } = await import("../../../src/config/access.js");
const { createToolSet } = await import("../../../src/ai/tools/toolset.js");
const { closeMCPClients, invalidateMCPToolCache } = await import(
  "../../../src/ai/tools/mcp.js"
);

afterAll(async () => {
  await closeMCPClients();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const toolContext = {
  client: {} as Client,
  guildId: "guild-1",
  channelId: "channel-1",
  userId: "user-1",
};

async function toolNames(
  disabled: string,
  ctxOverrides: Record<string, unknown> = {}
): Promise<string[]> {
  env.DISABLED_TOOLS = disabled;
  initAccessConfig(env);
  invalidateMCPToolCache();
  const openClients: MCPClient[] = [];
  const tools = await createToolSet(
    { ...toolContext, ...ctxOverrides },
    {},
    openClients
  );
  await Promise.allSettled(openClients.map((c) => c.close()));
  return Object.keys(tools);
}

test("an MCP tool with nowhere left to land is dropped rather than shadowing", async () => {
  const names = await toolNames("");

  // the built-in keeps its name
  assert.ok(names.includes("web_search"));
  // mcp_web_search is the server's own tool, sorted ahead of web_search and so
  // claimed first — which leaves the colliding web_search with no free name
  assert.ok(names.includes("mcp_web_search"));
  // no third variant was invented for it
  assert.ok(!names.includes("mcp_mcp_web_search"));
  // the server's uncontested tool is unaffected by any of this
  assert.ok(names.includes("unique_mcp_tool"));
  // exactly one entry per name
  assert.equal(names.length, new Set(names).size);
});

test("freeing the built-in name lets the replacement land after all", async () => {
  const names = await toolNames("web_search");
  assert.ok(names.includes("web_search"));
  assert.ok(names.includes("mcp_web_search"));
  assert.ok(names.includes("unique_mcp_tool"));
});

test("the mcp group removes every MCP tool and leaves built-ins whole", async () => {
  const names = await toolNames("mcp");
  assert.ok(!names.includes("unique_mcp_tool"));
  assert.ok(!names.includes("mcp_web_search"));
  assert.ok(names.includes("web_search"));
  assert.ok(names.includes("fetch_url"));
});

test("each built-in group can be switched off on its own", async () => {
  const groups: Array<[string, string]> = [
    ["discord", "get_server_info"],
    ["persona", "get_persona_part"],
    ["memory", "memory_search"],
    ["topic", "topic_search"],
    ["web", "fetch_url"],
    ["scheduler", "schedule_task"],
    ["heartbeat", "heartbeat_status"],
    ["logbook", "logbook_list"],
    ["user-input", "ask_questions"],
    ["skills", "list_skills"],
  ];

  const baseline = await toolNames("");
  for (const [group, sampleTool] of groups) {
    assert.ok(
      baseline.includes(sampleTool),
      `${sampleTool} should exist before ${group} is disabled`
    );
    const names = await toolNames(group);
    assert.ok(
      !names.includes(sampleTool),
      `disabling ${group} should drop ${sampleTool}`
    );
    // disabling one group leaves the others alone
    assert.ok(names.includes("logbook_get") || group === "logbook");
  }
});

test("shell tools appear only when SHELL_ENABLED is on", async () => {
  const originally = env.SHELL_ENABLED;
  try {
    env.SHELL_ENABLED = false;
    assert.ok(!(await toolNames("")).some((n) => n.startsWith("shell")));

    env.SHELL_ENABLED = true;
    const enabled = await toolNames("");
    assert.ok(enabled.some((n) => n.startsWith("shell")));

    // ...and the shell group still wins over the env flag
    const grouped = await toolNames("shell");
    assert.ok(!grouped.some((n) => n.startsWith("shell")));
  } finally {
    env.SHELL_ENABLED = originally;
  }
});

test("a DM turn with no user still builds a tool set", async () => {
  const names = await toolNames("", { guildId: null, userId: null });
  assert.ok(names.includes("logbook_list"));
  assert.ok(names.includes("unique_mcp_tool"));
});
