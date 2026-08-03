import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { discoverSkills } = await import("../../../src/ai/skills/loader.js");

const SKILLS_DIR = fileURLToPath(
  new URL("../../fixtures/skills", import.meta.url)
);
const GATE_ENV_VAR = "SKIFF_TEST_GATE_ENV_VAR";

afterEach(() => {
  delete process.env[GATE_ENV_VAR];
});

const byName = async (dir = SKILLS_DIR) => {
  const skills = await discoverSkills(dir);
  return new Map(skills.map((s) => [s.manifest.name, s]));
};

test("a missing skills directory yields no skills instead of throwing", async () => {
  assert.deepEqual(
    await discoverSkills(path.join(SKILLS_DIR, "definitely-not-here")),
    []
  );
});

test("a valid skill carries its manifest, body, directory and MCP flag", async () => {
  const skills = await byName();
  const greeter = skills.get("greeter");
  assert.ok(greeter);
  assert.equal(greeter.manifest.description, "Greets people warmly.");
  assert.equal(greeter.manifest.version, "1.2.3");
  assert.deepEqual(greeter.manifest.requires.env, []);
  assert.equal(greeter.dir, path.join(SKILLS_DIR, "greeter"));
  assert.equal(greeter.hasMCP, false);
  // the body is everything after the frontmatter, trimmed
  assert.ok(greeter.instructions.startsWith("## Instructions"));
  assert.ok(greeter.instructions.endsWith("Say hello to whoever asks."));
  assert.ok(!greeter.instructions.includes("name: greeter"));
});

test("a bundled mcp.json is detected", async () => {
  const skills = await byName();
  assert.equal(skills.get("with-mcp")?.hasMCP, true);
});

test("omitted manifest fields fall back to their defaults", async () => {
  const minimal = (await byName()).get("minimal");
  assert.ok(minimal);
  assert.equal(minimal.manifest.version, "0.0.0");
  assert.deepEqual(minimal.manifest.requires, { env: [] });
  assert.equal(minimal.instructions, "Minimal body.");
});

test("entries that are not loadable skills are quietly ignored", async () => {
  const names = [...(await byName()).keys()];
  // a loose file, a directory with no SKILL.md, and a dangling symlink
  assert.ok(!names.includes("loose-file.txt"));
  assert.ok(!names.includes("no-skill-file"));
  assert.ok(!names.includes("dangling-symlink"));
});

test("malformed frontmatter disqualifies a skill", async () => {
  const names = [...(await byName()).keys()];
  // missing a required field
  assert.ok(!names.includes("broken"));
  // no frontmatter fence at all
  assert.ok(!names.includes("no-frontmatter"));
  // an opening fence that never closes parses as no frontmatter
  assert.ok(!names.includes("unterminated"));
});

test("a skill gated on an unset env var is skipped", async () => {
  const names = [...(await byName()).keys()];
  assert.ok(!names.includes("gated-missing"));
  assert.ok(!names.includes("gated-present"));
});

test("a skill gated on a set env var loads", async () => {
  process.env[GATE_ENV_VAR] = "1";
  const names = [...(await byName()).keys()];
  assert.ok(names.includes("gated-present"));
  // the other gate is still unmet
  assert.ok(!names.includes("gated-missing"));
});

test("only the valid skills come back, and nothing else", async () => {
  const names = [...(await byName()).keys()].sort();
  assert.deepEqual(names, ["greeter", "minimal", "with-mcp"]);
});
