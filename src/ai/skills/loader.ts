import * as fs from "node:fs/promises";
import * as path from "node:path";
import yaml from "js-yaml";
import { logger } from "../../config/logger.js";
import { type LoadedSkill, skillManifestSchema } from "./schema.js";

const SKILL_FILE = "SKILL.md";
const MCP_FILE = "mcp.json";

/**
 * Parse a SKILL.md file into frontmatter (YAML) and body (markdown).
 * Expects `---` delimiters around the frontmatter block.
 */
function parseFrontmatter(raw: string): { data: unknown; body: string } {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) {
    return { data: {}, body: trimmed };
  }

  const end = trimmed.indexOf("---", 3);
  if (end === -1) {
    return { data: {}, body: trimmed };
  }

  const frontmatterText = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 3).trim();
  const data = yaml.load(frontmatterText);
  return { data, body };
}

/**
 * Check whether all required environment variables are set.
 * Returns the names of missing variables, or an empty array if all are present.
 */
function checkEnvGates(requiredEnv: string[]): string[] {
  return requiredEnv.filter((key) => !process.env[key]);
}

/**
 * Discover and load all valid skills from a directory.
 *
 * Each subdirectory containing a SKILL.md file is treated as a skill.
 * Skills whose gating requirements are not met are skipped with a log message.
 */
export async function discoverSkills(
  skillsDir: string
): Promise<LoadedSkill[]> {
  const resolved = path.resolve(skillsDir);

  let entries: string[];
  try {
    entries = await fs.readdir(resolved);
  } catch {
    logger.debug(`Skills directory not found: ${resolved}`);
    return [];
  }

  const skills: LoadedSkill[] = [];

  for (const entry of entries) {
    const skillDir = path.join(resolved, entry);
    const stat = await fs.stat(skillDir).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const skillFile = path.join(skillDir, SKILL_FILE);
    const raw = await fs.readFile(skillFile, "utf-8").catch(() => null);
    if (!raw) continue;

    // Parse frontmatter
    const { data, body } = parseFrontmatter(raw);
    const result = skillManifestSchema.safeParse(data);
    if (!result.success) {
      logger.warn(
        `Skipping skill in ${entry}/: invalid SKILL.md frontmatter — ${result.error.message}`
      );
      continue;
    }

    const manifest = result.data;

    // Check gating requirements
    const missingEnv = checkEnvGates(manifest.requires.env);
    if (missingEnv.length > 0) {
      logger.debug(
        `Skipping skill "${manifest.name}": missing env vars: ${missingEnv.join(", ")}`
      );
      continue;
    }

    // Check for MCP config
    const mcpPath = path.join(skillDir, MCP_FILE);
    const hasMCP = await fs
      .access(mcpPath)
      .then(() => true)
      .catch(() => false);

    skills.push({
      manifest,
      instructions: body,
      dir: skillDir,
      hasMCP,
    });

    logger.info(
      `Loaded skill: ${manifest.name} v${manifest.version}${hasMCP ? " (with MCP tools)" : ""}`
    );
  }

  return skills;
}
