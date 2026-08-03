import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { getAllSkills, getSkill, getSkillCatalog, initSkills, reloadSkills } =
  await import("../../../src/ai/skills/index.js");

const SKILLS_DIR = fileURLToPath(
  new URL("../../fixtures/skills", import.meta.url)
);
const RELOAD_DIR = fileURLToPath(
  new URL("../../fixtures/skills-reload", import.meta.url)
);

// the cache is module-global, so this runs first: the empty state exists once
test("nothing is cached before init runs", () => {
  assert.deepEqual(getAllSkills(), []);
  assert.deepEqual(getSkillCatalog(), []);
  assert.equal(getSkill("greeter"), undefined);
});

test("init fills the cache from disk", async () => {
  await initSkills(SKILLS_DIR);

  const names = getAllSkills().map((s) => s.manifest.name);
  assert.deepEqual([...names].sort(), ["greeter", "minimal", "with-mcp"]);
});

test("the catalog is name and description only", async () => {
  await initSkills(SKILLS_DIR);

  const entry = getSkillCatalog().find((s) => s.name === "greeter");
  assert.deepEqual(entry, {
    name: "greeter",
    description: "Greets people warmly.",
  });
  // instructions and paths stay out of the system prompt
  assert.deepEqual(
    getSkillCatalog().every(
      (s) => Object.keys(s).sort().join(",") === "description,name"
    ),
    true
  );
});

test("lookup by name returns the full skill, or nothing", async () => {
  await initSkills(SKILLS_DIR);

  const greeter = getSkill("greeter");
  assert.ok(greeter);
  assert.equal(greeter.manifest.version, "1.2.3");
  assert.ok(greeter.instructions.length > 0);
  assert.equal(greeter.hasMCP, false);

  assert.equal(getSkill("with-mcp")?.hasMCP, true);
  assert.equal(getSkill("nonexistent"), undefined);
});

test("reloading swaps the cache wholesale", async () => {
  await initSkills(SKILLS_DIR);
  assert.ok(getSkill("greeter"));

  await reloadSkills(RELOAD_DIR);

  assert.deepEqual(
    getAllSkills().map((s) => s.manifest.name),
    ["solo"]
  );
  assert.equal(getSkill("solo")?.manifest.version, "2.0.0");
  // skills that vanished from disk are gone from the cache too
  assert.equal(getSkill("greeter"), undefined);
});

test("reloading an empty directory empties the cache", async () => {
  await initSkills(SKILLS_DIR);
  assert.ok(getAllSkills().length > 0);

  await reloadSkills(path.join(SKILLS_DIR, "no-skill-file"));

  assert.deepEqual(getAllSkills(), []);
  assert.deepEqual(getSkillCatalog(), []);
});
