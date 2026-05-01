import { z } from "zod";

export const skillManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.string().default("0.0.0"),
  requires: z
    .object({
      env: z.array(z.string()).default([]),
    })
    .default({ env: [] }),
});

export type SkillManifest = z.infer<typeof skillManifestSchema>;

export interface LoadedSkill {
  manifest: SkillManifest;
  /** Markdown body from SKILL.md (everything after the frontmatter). */
  instructions: string;
  /** Absolute path to the skill directory. */
  dir: string;
  /** Whether an mcp.json file exists in the skill directory. */
  hasMCP: boolean;
}
