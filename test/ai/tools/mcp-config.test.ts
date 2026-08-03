// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the ${VAR} literals
// are MCP config placeholders under test, not JavaScript interpolation.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, test } from "vitest";
import { bootstrapTestEnv, MISSING_MCP_CONFIG } from "../../helpers/setup.js";

bootstrapTestEnv();
// mcp.ts spawns the configured servers in its module body; this file is about
// parsing and connection failures, so start it with nothing to connect to.
process.env.MCP_CONFIG_PATH = MISSING_MCP_CONFIG;

const { loadMCPConfig, getMCPServers, closeMCPClients } = await import(
  "../../../src/ai/tools/mcp.js"
);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skiff-mcp-config-"));
let seq = 0;

/** Writes a config file and returns its absolute path. */
function writeConfig(contents: unknown): string {
  const file = path.join(tmpDir, `config-${seq++}.json`);
  fs.writeFileSync(
    file,
    typeof contents === "string" ? contents : JSON.stringify(contents)
  );
  return file;
}

afterAll(async () => {
  await closeMCPClients();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// loading and validation

test("loadMCPConfig reads a valid config and leaves it intact", async () => {
  const file = writeConfig({
    mcpServers: {
      remote: { type: "http", url: "https://example.invalid/mcp" },
      streamed: { type: "sse", url: "https://example.invalid/sse" },
      local: { type: "stdio", command: "node", args: ["server.mjs"] },
    },
  });

  const config = await loadMCPConfig(file);
  assert.deepEqual(Object.keys(config.mcpServers), [
    "remote",
    "streamed",
    "local",
  ]);
});

test("loadMCPConfig accepts a file:// location", async () => {
  const file = writeConfig({
    mcpServers: { local: { type: "stdio", command: "node" } },
  });
  const config = await loadMCPConfig(pathToFileURL(file).href);
  assert.ok(config.mcpServers.local);
});

test("a missing config file names the path it tried", async () => {
  const missing = path.join(tmpDir, "not-here.json");
  await assert.rejects(
    () => loadMCPConfig(missing),
    (err: Error) =>
      err.message.startsWith(`Failed to read MCP config from ${missing}:`)
  );
});

test("with no argument the configured path is used", async () => {
  // env.MCP_CONFIG_PATH is the deliberately missing fixture path
  await assert.rejects(
    () => loadMCPConfig(),
    /Failed to read MCP config from .*skiff-test-missing-mcp\.json/
  );
});

test("malformed JSON surfaces as a parse error", async () => {
  const file = writeConfig("{ not json");
  await assert.rejects(() => loadMCPConfig(file), SyntaxError);
});

test("a config without an mcpServers object is rejected", async () => {
  await assert.rejects(
    () => loadMCPConfig(writeConfig({})),
    /Invalid MCP config: missing or invalid mcpServers/
  );
  await assert.rejects(
    () => loadMCPConfig(writeConfig({ mcpServers: "everything" })),
    /Invalid MCP config: missing or invalid mcpServers/
  );
});

test("each server needs a recognised type", async () => {
  await assert.rejects(
    () => loadMCPConfig(writeConfig({ mcpServers: { one: {} } })),
    /Invalid MCP server config for one: missing or invalid type/
  );
  await assert.rejects(
    () =>
      loadMCPConfig(writeConfig({ mcpServers: { one: { type: "carrier" } } })),
    /Invalid MCP server config for one: missing or invalid type/
  );
});

test("http and sse servers need a url, stdio servers need a command", async () => {
  await assert.rejects(
    () => loadMCPConfig(writeConfig({ mcpServers: { a: { type: "http" } } })),
    /Invalid MCP server config for a: missing url/
  );
  await assert.rejects(
    () => loadMCPConfig(writeConfig({ mcpServers: { b: { type: "sse" } } })),
    /Invalid MCP server config for b: missing url/
  );
  await assert.rejects(
    () => loadMCPConfig(writeConfig({ mcpServers: { c: { type: "stdio" } } })),
    /Invalid MCP server config for c: missing command/
  );
});

// environment interpolation

test("${VAR} is substituted into headers and stdio env", async () => {
  process.env.SKIFF_TEST_MCP_TOKEN = "s3cret";
  process.env.SKIFF_TEST_MCP_HOME = "/opt/skiff";
  const file = writeConfig({
    mcpServers: {
      remote: {
        type: "http",
        url: "https://example.invalid/mcp",
        headers: {
          Authorization: "Bearer ${SKIFF_TEST_MCP_TOKEN}",
          "X-Both": "${SKIFF_TEST_MCP_TOKEN}/${SKIFF_TEST_MCP_HOME}",
          "X-Plain": "no placeholders here",
        },
      },
      streamed: {
        type: "sse",
        url: "https://example.invalid/sse",
        headers: { Authorization: "Bearer ${SKIFF_TEST_MCP_TOKEN}" },
      },
      local: {
        type: "stdio",
        command: "node",
        env: { HOME_DIR: "${SKIFF_TEST_MCP_HOME}" },
      },
    },
  });

  const config = await loadMCPConfig(file);
  const remote = config.mcpServers.remote as {
    headers: Record<string, string>;
  };
  assert.equal(remote.headers.Authorization, "Bearer s3cret");
  assert.equal(remote.headers["X-Both"], "s3cret//opt/skiff");
  assert.equal(remote.headers["X-Plain"], "no placeholders here");
  const streamed = config.mcpServers.streamed as {
    headers: Record<string, string>;
  };
  assert.equal(streamed.headers.Authorization, "Bearer s3cret");
  const local = config.mcpServers.local as { env: Record<string, string> };
  assert.equal(local.env.HOME_DIR, "/opt/skiff");

  process.env.SKIFF_TEST_MCP_TOKEN = undefined;
  delete process.env.SKIFF_TEST_MCP_TOKEN;
  delete process.env.SKIFF_TEST_MCP_HOME;
});

test("an unset ${VAR} fails loudly rather than sending an empty header", async () => {
  delete process.env.SKIFF_TEST_MCP_ABSENT;
  const file = writeConfig({
    mcpServers: {
      remote: {
        type: "http",
        url: "https://example.invalid/mcp",
        headers: { Authorization: "Bearer ${SKIFF_TEST_MCP_ABSENT}" },
      },
    },
  });
  await assert.rejects(
    () => loadMCPConfig(file),
    /MCP config references environment variable \$\{SKIFF_TEST_MCP_ABSENT\} which is not set/
  );
});

test("servers without headers or env are left alone", async () => {
  const file = writeConfig({
    mcpServers: {
      remote: { type: "http", url: "https://example.invalid/mcp" },
      local: { type: "stdio", command: "node" },
    },
  });
  const config = await loadMCPConfig(file);
  assert.equal(
    (config.mcpServers.remote as { headers?: unknown }).headers,
    undefined
  );
  assert.equal((config.mcpServers.local as { env?: unknown }).env, undefined);
});

// getMCPServers degradation

test("an unloadable config yields no clients instead of throwing", async () => {
  assert.deepEqual(
    await getMCPServers(path.join(tmpDir, "does-not-exist.json")),
    []
  );
  assert.deepEqual(await getMCPServers(writeConfig({ mcpServers: 3 })), []);
});

test("servers that refuse the connection are skipped, not fatal", async () => {
  // port 1 on loopback: connection refused immediately, no network involved
  const file = writeConfig({
    mcpServers: {
      remote: { type: "http", url: "http://127.0.0.1:1/mcp" },
      streamed: { type: "sse", url: "http://127.0.0.1:1/sse" },
      local: {
        type: "stdio",
        command: "skiff-command-that-does-not-exist",
        args: [],
        env: {},
      },
    },
  });

  assert.deepEqual(await getMCPServers(file), []);
});
