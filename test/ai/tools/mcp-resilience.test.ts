import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

// Four stdio servers with scripted listing behaviour. They have to exist and
// be configured before mcp.ts is imported, because its module body connects
// every configured server on load — hence a file of its own, built here rather
// than checked in since the point of each one is how it misbehaves.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skiff-mcp-resilience-"));

/**
 * @param tools tool names to advertise
 * @param failAfter listings served successfully before the server starts
 *   erroring; 0 means it never manages one.
 */
function writeServer(
  name: string,
  tools: string[],
  failAfter = Number.POSITIVE_INFINITY
): string {
  const file = path.join(tmpDir, `${name}.mjs`);
  fs.writeFileSync(
    file,
    `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const TOOLS = ${JSON.stringify(
      tools.map((t) => ({
        name: t,
        description: t,
        inputSchema: { type: "object", properties: {} },
      }))
    )};
const FAIL_AFTER = ${failAfter === Number.POSITIVE_INFINITY ? "Infinity" : failAfter};
let listings = 0;
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
        serverInfo: { name: ${JSON.stringify(name)}, version: "0.0.0" },
      }});
    } else if (msg.method === "tools/list") {
      if (listings >= FAIL_AFTER) {
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "listing unavailable" } });
      } else {
        listings++;
        send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
      }
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});
`
  );
  return file;
}

const servers = {
  // "alpha" is listed first, so it wins the shared_tool name
  alpha: writeServer("alpha", ["shared_tool", "alpha_tool"]),
  beta: writeServer("beta", ["shared_tool", "beta_tool"]),
  // serves one good listing, then goes dark
  flaky: writeServer("flaky", ["flaky_tool"], 1),
  // never manages a listing at all
  broken: writeServer("broken", ["broken_tool"], 0),
};

const configPath = path.join(tmpDir, "mcp.json");
fs.writeFileSync(
  configPath,
  JSON.stringify({
    mcpServers: Object.fromEntries(
      Object.entries(servers).map(([name, script]) => [
        name,
        { type: "stdio", command: process.execPath, args: [script] },
      ])
    ),
  })
);
process.env.MCP_CONFIG_PATH = configPath;

const { env } = await import("../../../src/config/env.js");
const { createToolset, invalidateMCPToolCache, closeMCPClients } = await import(
  "../../../src/ai/tools/mcp.js"
);

afterAll(async () => {
  await closeMCPClients();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("a server that never lists its tools costs only its own tools", async () => {
  env.MCP_TOOLS_CACHE_TTL_MS = 300_000;
  invalidateMCPToolCache();

  const names = Object.keys(await createToolset());
  assert.ok(names.includes("alpha_tool"));
  assert.ok(names.includes("beta_tool"));
  assert.ok(names.includes("flaky_tool"));
  // broken never answered, and has no earlier listing to fall back on
  assert.ok(!names.includes("broken_tool"));
});

test("a name defined by two servers resolves to the first one listed", async () => {
  env.MCP_TOOLS_CACHE_TTL_MS = 300_000;
  invalidateMCPToolCache();

  const tools = await createToolset();
  const matching = Object.keys(tools).filter((n) => n.includes("shared_tool"));
  // one entry, not two and not a mangled name
  assert.deepEqual(matching, ["shared_tool"]);
  assert.equal(
    (tools.shared_tool as { description?: string }).description,
    "shared_tool"
  );
});

test("a server that blips keeps its previous tools rather than vanishing", async () => {
  env.MCP_TOOLS_CACHE_TTL_MS = 300_000;
  invalidateMCPToolCache();

  // first build: flaky answers, and its listing is remembered
  const first = Object.keys(await createToolset());
  assert.ok(first.includes("flaky_tool"));

  // second build: flaky now errors, but the last known listing stands in.
  // Losing it would shrink the tool array and invalidate the whole
  // prompt-cache prefix for as long as the server stayed down.
  invalidateMCPToolCache();
  const second = Object.keys(await createToolset());
  assert.ok(second.includes("flaky_tool"));
  assert.deepEqual(second, first);

  // and it still holds on a third pass
  invalidateMCPToolCache();
  assert.ok(Object.keys(await createToolset()).includes("flaky_tool"));
});

test("the merged set stays sorted no matter which servers answered", async () => {
  env.MCP_TOOLS_CACHE_TTL_MS = 300_000;
  invalidateMCPToolCache();
  const names = Object.keys(await createToolset());
  assert.deepEqual(names, [...names].sort());
});

// runs last: it shuts the fixture servers down
test("closing the clients drops the tool map bound to them", async () => {
  env.MCP_TOOLS_CACHE_TTL_MS = 300_000;
  invalidateMCPToolCache();

  const built = await createToolset();
  // a warm cache hands back the very same object
  assert.equal(await createToolset(), built);

  await closeMCPClients();

  // the cached map held tools bound to clients that just went away, so it is
  // dropped rather than served again
  assert.notEqual(await createToolset(), built);

  // and closing again is a no-op rather than an error
  await closeMCPClients();
});
