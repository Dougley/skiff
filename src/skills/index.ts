import { logger } from "../logger/index.js";
import { discoverSkills } from "./loader.js";
import type { LoadedSkill } from "./schema.js";

let cachedSkills: LoadedSkill[] = [];

/**
 * Discover and cache all skills from the given directory.
 * Call once at startup.
 */
export async function initSkills(skillsDir: string): Promise<void> {
  cachedSkills = await discoverSkills(skillsDir);
  logger.info(`Skills loaded: ${cachedSkills.length}`);
}

/**
 * Rediscover skills and atomically swap the cache. Used by the sleep cycle
 * after authoring new skills on disk, and by rollback when deleting them.
 */
export async function reloadSkills(skillsDir: string): Promise<void> {
  const next = await discoverSkills(skillsDir);
  cachedSkills = next;
  logger.info(`Skills reloaded: ${next.length}`);
}

/**
 * Lightweight catalog for the system prompt — name and description only.
 */
export function getSkillCatalog(): { name: string; description: string }[] {
  return cachedSkills.map((s) => ({
    name: s.manifest.name,
    description: s.manifest.description,
  }));
}

/**
 * Snapshot of all currently loaded skills. Used by the sleep cycle's
 * propose-skills phase to avoid authoring duplicates.
 */
export function getAllSkills(): LoadedSkill[] {
  return cachedSkills;
}

/**
 * Look up a loaded skill by name. Used by the activate_skill tool.
 */
export function getSkill(name: string): LoadedSkill | undefined {
  return cachedSkills.find((s) => s.manifest.name === name);
}

export type { LoadedSkill } from "./schema.js";
