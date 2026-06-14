import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateObject } from "ai";
import { and, desc, gt, sql } from "drizzle-orm";
import yaml from "js-yaml";
import { z } from "zod";
import { getLLMProvider } from "../../../ai/llm/provider.js";
import { getAllSkills, reloadSkills } from "../../../ai/skills/index.js";
import { env } from "../../../config/env.js";
import { logger } from "../../../config/logger.js";
import { db, messages } from "../../../db/index.js";
import {
  SLEEP_PROPOSE_LOOKBACK_MS,
  SLEEP_PROPOSE_MAX_USER_MESSAGES,
  SLEEP_PROPOSE_MIN_CONFIDENCE,
} from "../config.js";
import { addStat, type DreamContext, logChange } from "../context.js";

const PHASE = "propose_skills";
const AUTO_PREFIX = "auto-";

const proposalSchema = z.object({
  proposals: z
    .array(
      z.object({
        slug: z
          .string()
          .regex(/^[a-z0-9-]+$/, "lowercase, hyphen, digits only")
          .min(3)
          .max(40)
          .describe("URL-safe slug. Will be prefixed with 'auto-'."),
        title: z.string().min(1),
        description: z.string().min(1).max(200),
        body: z
          .string()
          .min(40)
          .describe(
            "Markdown instructions the LLM will be given when this skill is activated."
          ),
        confidence: z.number().min(0).max(100),
      })
    )
    .default([]),
});

/**
 * Detect recurring user-request patterns and (if allowed) write new skill
 * markdown files to disk. Every authored skill is prefixed with `auto-` so
 * it can never be confused with a hand-written skill.
 */
export async function proposeSkills(ctx: DreamContext): Promise<void> {
  const modelId = env.MEMORY_EXTRACT_MODEL ?? env.LLM_DEFAULT_MODEL;
  if (modelId === "disabled") return;

  const cutoff = new Date(ctx.now.getTime() - SLEEP_PROPOSE_LOOKBACK_MS);

  const userMessages = await db
    .select({
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(
      and(
        gt(messages.createdAt, cutoff),
        sql`${messages.role} = 'user'`,
        sql`${messages.content} is not null`,
        ctx.guildId === null
          ? sql`1 = 1`
          : sql`${messages.conversationId} in (select id from conversations where guild_id = ${ctx.guildId})`
      )
    )
    .orderBy(desc(messages.createdAt))
    .limit(SLEEP_PROPOSE_MAX_USER_MESSAGES);

  if (userMessages.length < 20) {
    addStat(ctx, PHASE, "skippedLowSignal");
    return;
  }
  addStat(ctx, PHASE, "messagesConsidered", userMessages.length);

  const existing = getAllSkills().map((s) => s.manifest.name);

  let result: z.infer<typeof proposalSchema>;
  try {
    const r = await generateObject({
      model: getLLMProvider(undefined, modelId),
      schema: proposalSchema,
      prompt: [
        "Scan these recent user requests for recurring task patterns that a focused skill could serve better than a generic response.",
        "Only propose skills for patterns you see at least 3 times. Don't propose skills that duplicate what already exists.",
        `Existing skills (do not duplicate): ${existing.join(", ") || "(none)"}`,
        "",
        "Return at most 2 high-confidence proposals. Each 'body' should be concrete markdown instructions — how to approach the request, what tools to prefer, what pitfalls to avoid.",
        "",
        "Recent user messages:",
        ...userMessages
          .slice(0, 80)
          .map((m, i) => `[${i + 1}] ${(m.content ?? "").slice(0, 300)}`),
      ].join("\n"),
      maxRetries: 1,
    });
    result = r.object;
    ctx.tokenUsage +=
      (r.usage?.inputTokens ?? 0) + (r.usage?.outputTokens ?? 0);
  } catch (err) {
    logger.warn("sleep: propose-skills LLM failed", { err });
    return;
  }

  const seenSlugs = new Set<string>();
  const qualified = result.proposals
    .filter((p) => p.confidence >= SLEEP_PROPOSE_MIN_CONFIDENCE)
    .filter((p) => !existing.includes(`${AUTO_PREFIX}${p.slug}`))
    .filter((p) => {
      if (seenSlugs.has(p.slug)) return false;
      seenSlugs.add(p.slug);
      return true;
    })
    .slice(0, 2);

  if (qualified.length === 0) {
    addStat(ctx, PHASE, "noQualifying");
    return;
  }

  // Authored skills must live as an immediate child of SKILLS_DIR so
  // discoverSkills picks them up. The `auto-` name prefix is what
  // identifies them as auto-authored (not the directory). Dry-run mode
  // records the proposal via logChange but never touches the filesystem.
  const baseRoot = resolve(env.SKILLS_DIR);

  let authored = 0;
  for (const prop of qualified) {
    const name = `${AUTO_PREFIX}${prop.slug}`;
    const dirName = `${name}-${ctx.runId}`;
    const skillDir = join(baseRoot, dirName);
    const frontmatter = `---\n${yaml.dump(
      {
        name,
        description: prop.description,
        version: `0.1.0-run${ctx.runId}`,
      },
      { lineWidth: -1 }
    )}---\n`;
    const body = `# ${prop.title}\n\n<!-- auto-authored by sleep cycle run ${ctx.runId} -->\n\n${prop.body}\n`;

    if (!ctx.dryRun) {
      try {
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          frontmatter + body,
          "utf-8"
        );
      } catch (err) {
        logger.warn("sleep: failed to write authored skill", {
          slug: prop.slug,
          err,
        });
        continue;
      }
    }

    await logChange({
      runId: ctx.runId,
      kind: "skill_author",
      targetTable: "filesystem",
      targetId: skillDir,
      before: null,
      after: {
        name,
        description: prop.description,
        title: prop.title,
        confidence: prop.confidence,
        dryRun: ctx.dryRun,
      },
    });
    authored++;
    addStat(ctx, PHASE, ctx.dryRun ? "proposalsPending" : "skillsAuthored");
  }

  if (authored > 0 && !ctx.dryRun) {
    try {
      await reloadSkills(env.SKILLS_DIR);
    } catch (err) {
      logger.warn("sleep: reloadSkills after authoring failed", { err });
    }
  }
}
