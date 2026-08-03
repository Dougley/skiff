import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { MCPClient } from "@ai-sdk/mcp";
import { afterAll, beforeAll, test } from "vitest";
import { bootstrapTestEnv, MISSING_MCP_CONFIG } from "../../helpers/setup.js";

bootstrapTestEnv();
// skills.ts pulls in mcp.ts, whose module body spawns the configured servers
// on import. Point it at nothing so only the per-skill configs below run.
process.env.MCP_CONFIG_PATH = MISSING_MCP_CONFIG;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

// Skill fixtures are built here rather than checked in: two of them need a
// stdio MCP server with specific failure behaviour, which only makes sense
// alongside the tests that drive it.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skiff-skill-tools-"));
const skillsDir = path.join(tmpRoot, "skills");
const emptyDir = path.join(tmpRoot, "empty");
fs.mkdirSync(emptyDir, { recursive: true });

/** A stdio MCP server that answers tools/list with the given tool names. */
function serverScript(toolNames: string[], failListing: boolean): string {
  return `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
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
        serverInfo: { name: "skiff-test-skill", version: "0.0.0" },
      }});
    } else if (msg.method === "tools/list") {
      ${
        failListing
          ? `send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "tool listing is broken" } });`
          : `send({ jsonrpc: "2.0", id: msg.id, result: { tools: ${JSON.stringify(
              toolNames.map((name) => ({
                name,
                description: name,
                inputSchema: { type: "object", properties: {} },
              }))
            )} }});`
      }
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
  }
});
`;
}

interface SkillFixture {
  name: string;
  instructions: string;
  /** Tool names the bundled server exposes; omit for a skill without mcp.json. */
  tools?: string[];
  failListing?: boolean;
  /** Write an mcp.json that configures no servers at all. */
  noServers?: boolean;
}

function writeSkill(fixture: SkillFixture): void {
  const dir = path.join(skillsDir, fixture.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${fixture.name}\ndescription: The ${fixture.name} skill.\nversion: 1.0.0\n---\n\n${fixture.instructions}\n`
  );

  if (fixture.noServers) {
    fs.writeFileSync(
      path.join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: {} })
    );
    return;
  }
  if (!fixture.tools && !fixture.failListing) return;

  const script = path.join(dir, "server.mjs");
  fs.writeFileSync(
    script,
    serverScript(fixture.tools ?? [], fixture.failListing ?? false)
  );
  fs.writeFileSync(
    path.join(dir, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        bundled: { type: "stdio", command: process.execPath, args: [script] },
      },
    })
  );
}

writeSkill({ name: "plain", instructions: "Do the plain thing." });
writeSkill({
  name: "tooled",
  instructions: "Use the bundled tools.",
  tools: ["bundled_alpha", "bundled_beta"],
});
writeSkill({
  name: "no-servers",
  instructions: "Declares MCP but configures nothing.",
  noServers: true,
});
writeSkill({
  name: "broken",
  instructions: "Its server cannot list tools.",
  failListing: true,
});

const toolOpts = { toolCallId: "test-call", messages: [] } as never;

let createSkillTools: typeof import("../../../src/ai/tools/skills.js").createSkillTools;
let skillRegistry: typeof import("../../../src/ai/skills/index.js");

const openClients: MCPClient[] = [];

beforeAll(async () => {
  const [tools, registry] = await Promise.all([
    import("../../../src/ai/tools/skills.js"),
    import("../../../src/ai/skills/index.js"),
  ]);
  createSkillTools = tools.createSkillTools;
  skillRegistry = registry;
});

afterAll(async () => {
  await Promise.allSettled(openClients.map((c) => c.close()));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** Builds the tools with fresh per-turn sinks so tests don't share state. */
function build() {
  const pendingSkillTools: Record<string, unknown> = {};
  const clients: MCPClient[] = [];
  const tools = createSkillTools(pendingSkillTools, clients);
  return { tools, pendingSkillTools, clients };
}

test("list_skills says so when nothing is loaded", async () => {
  await skillRegistry.initSkills(emptyDir);
  const { tools } = build();
  assert.equal(
    await tools.list_skills.execute?.({}, toolOpts),
    "No skills available."
  );
});

test("list_skills returns the catalog as JSON with names and descriptions", async () => {
  await skillRegistry.initSkills(skillsDir);
  const { tools } = build();
  const raw = (await tools.list_skills.execute?.({}, toolOpts)) as string;
  const catalog = JSON.parse(raw) as Array<{
    name: string;
    description: string;
  }>;

  assert.deepEqual(catalog.map((s) => s.name).sort(), [
    "broken",
    "no-servers",
    "plain",
    "tooled",
  ]);
  assert.equal(
    catalog.find((s) => s.name === "plain")?.description,
    "The plain skill."
  );
  // the catalog is name and description only — instructions stay out of it
  assert.deepEqual(Object.keys(catalog[0] ?? {}).sort(), [
    "description",
    "name",
  ]);
});

test("activate_skill returns the instruction body for a plain skill", async () => {
  await skillRegistry.initSkills(skillsDir);
  const { tools, pendingSkillTools, clients } = build();
  const result = await tools.activate_skill.execute?.(
    { name: "plain" },
    toolOpts
  );
  assert.equal(result, "Do the plain thing.");
  // nothing to load, so nothing is queued or opened
  assert.deepEqual(pendingSkillTools, {});
  assert.deepEqual(clients, []);
});

test("activate_skill reports an unknown skill by name", async () => {
  await skillRegistry.initSkills(skillsDir);
  const { tools } = build();
  assert.equal(
    await tools.activate_skill.execute?.({ name: "nonexistent" }, toolOpts),
    'Skill "nonexistent" not found.'
  );
});

test("a skill's MCP tools are queued for injection and announced to the model", async () => {
  await skillRegistry.initSkills(skillsDir);
  const { tools, pendingSkillTools, clients } = build();

  const result = (await tools.activate_skill.execute?.(
    { name: "tooled" },
    toolOpts
  )) as string;
  openClients.push(...clients);

  assert.match(result, /^Use the bundled tools\./);
  assert.match(
    result,
    /This skill provides the following tools: bundled_alpha, bundled_beta/
  );
  // the outer turn loop picks these up from the sink
  assert.deepEqual(Object.keys(pendingSkillTools).sort(), [
    "bundled_alpha",
    "bundled_beta",
  ]);
  // and the client is tracked so the turn can close it afterwards
  assert.equal(clients.length, 1);
});

test("a skill whose mcp.json configures no servers just returns instructions", async () => {
  await skillRegistry.initSkills(skillsDir);
  const { tools, pendingSkillTools, clients } = build();
  const result = await tools.activate_skill.execute?.(
    { name: "no-servers" },
    toolOpts
  );

  assert.equal(result, "Declares MCP but configures nothing.");
  // no tool list means no announcement line is appended
  assert.deepEqual(pendingSkillTools, {});
  assert.deepEqual(clients, []);
});

test("a server that cannot list its tools degrades into a note, not a thrown turn", async () => {
  await skillRegistry.initSkills(skillsDir);
  const { tools, pendingSkillTools, clients } = build();

  const result = (await tools.activate_skill.execute?.(
    { name: "broken" },
    toolOpts
  )) as string;
  openClients.push(...clients);

  // the instructions still arrive — the skill is usable without its tools
  assert.match(result, /^Its server cannot list tools\./);
  assert.match(result, /Failed to load skill MCP tools: /);
  assert.deepEqual(pendingSkillTools, {});
});

test("a skill directory that vanished is loadable but yields no MCP tools", async () => {
  // the loader recorded hasMCP, then the config disappeared underneath it
  await skillRegistry.initSkills(skillsDir);
  const mcpPath = path.join(skillsDir, "no-servers", "mcp.json");
  const saved = fs.readFileSync(mcpPath, "utf-8");
  fs.rmSync(mcpPath);

  const { tools, pendingSkillTools } = build();
  const result = await tools.activate_skill.execute?.(
    { name: "no-servers" },
    toolOpts
  );
  // getMCPServers swallows the missing config and returns no clients
  assert.equal(result, "Declares MCP but configures nothing.");
  assert.deepEqual(pendingSkillTools, {});

  fs.writeFileSync(mcpPath, saved);
});

test("skills are read from the repo's own fixture directory too", async () => {
  // guards the loader/tool seam against the temp-fixture shape drifting
  await skillRegistry.initSkills(path.join(repoRoot, "test/fixtures/skills"));
  const { tools } = build();
  const catalog = JSON.parse(
    (await tools.list_skills.execute?.({}, toolOpts)) as string
  ) as Array<{ name: string }>;
  assert.ok(catalog.some((s) => s.name === "greeter"));

  const result = (await tools.activate_skill.execute?.(
    { name: "greeter" },
    toolOpts
  )) as string;
  assert.match(result, /Say hello to whoever asks\./);
});
