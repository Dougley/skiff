import assert from "node:assert/strict";
import test, { after } from "node:test";

process.env.DISCORD_BOT_TOKEN = `${Buffer.from("123456789012345678").toString("base64")}.test.signature`;
process.env.OPENAI_API_KEY = "test";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.DATABASE_URL = "memory://";
// MCP clients are created once when the module is imported, so this has to be
// set before the dynamic imports below — hence a file of its own.
process.env.MCP_CONFIG_PATH = "test/fixtures/mcp-counting.json";

const { env } = await import("../src/config/env.js");
const { closeMCPClients, createToolset, invalidateMCPToolCache } = await import(
  "../src/ai/tools/mcp.js"
);

after(() => closeMCPClients());

/**
 * The fixture server names one of its tools after the number of tools/list
 * requests it has served, so the built tool set reveals whether a listing
 * round-trip actually happened.
 */
function listCallsSeen(tools: Record<string, unknown>): number {
  const marker = Object.keys(tools).find((n) => n.startsWith("list_calls_"));
  assert.ok(marker, "the fixture server should always name its call counter");
  return Number(marker.slice("list_calls_".length));
}

test("a second build reuses the listing instead of re-fetching", async () => {
  env.MCP_TOOLS_CACHE_TTL_MS = 300_000;
  invalidateMCPToolCache();

  const first = await createToolset();
  const second = await createToolset();

  assert.equal(listCallsSeen(first), listCallsSeen(second));
  assert.deepEqual(Object.keys(first), Object.keys(second));
});

test("invalidating forces a fresh listing", async () => {
  env.MCP_TOOLS_CACHE_TTL_MS = 300_000;
  const before = listCallsSeen(await createToolset());

  invalidateMCPToolCache();
  const refetched = listCallsSeen(await createToolset());

  assert.equal(refetched, before + 1);
});

test("concurrent builds share one listing", async () => {
  env.MCP_TOOLS_CACHE_TTL_MS = 300_000;
  invalidateMCPToolCache();
  const before = listCallsSeen(await createToolset());

  invalidateMCPToolCache();
  const [a, b, c] = await Promise.all([
    createToolset(),
    createToolset(),
    createToolset(),
  ]);

  // three callers, one round-trip — not three
  assert.equal(listCallsSeen(a), before + 1);
  assert.equal(listCallsSeen(b), before + 1);
  assert.equal(listCallsSeen(c), before + 1);
});

test("a zero TTL turns the cache off", async () => {
  env.MCP_TOOLS_CACHE_TTL_MS = 0;
  invalidateMCPToolCache();

  const first = listCallsSeen(await createToolset());
  const second = listCallsSeen(await createToolset());

  assert.equal(second, first + 1);
  env.MCP_TOOLS_CACHE_TTL_MS = 300_000;
});

test("tools stay sorted so the prompt-cache prefix holds still", async () => {
  env.MCP_TOOLS_CACHE_TTL_MS = 300_000;
  invalidateMCPToolCache();

  const names = Object.keys(await createToolset());
  assert.deepEqual(names, [...names].sort());
});
