import { buildSystemPrompt } from "../aieos/prompt.js";
import type { AIEOS } from "../aieos/schema.js";
import { getAieos, hasAieos } from "../aieos/state.js";
import { env } from "../env/index.js";
import { getSkillCatalog } from "../skills/index.js";
import { getActiveAddenda } from "../sleep/addenda.js";

import type { MessageContext } from "./conversation-turn.js";

type SystemPromptOptions = {
  userFacts?: string[];
  messageContext?: MessageContext;
  /** Guild ID for scoping durable persona addenda. */
  guildId?: string | null;
};

/**
 * The system prompt is split into two contiguous spans:
 *
 *   stable   — persona, platform rules, durable addenda, tool/skill instructions.
 *              identical across users/channels and stable for the lifetime of the
 *              process (modulo addenda updates from the sleep cycle). marked with
 *              an anthropic ephemeral cache breakpoint at the call site.
 *
 *   variable — chat context, current time, per-user facts. changes per turn,
 *              so it must come *after* the cache breakpoint.
 *
 * NB: per-user facts MUST stay in `variable`. anthropic's prompt cache is
 * content-hashed; mixing per-user facts into the cached span would let one
 * user's facts leak into another user's cache lookup key.
 */
export interface SystemPromptParts {
  stable: string;
  variable: string;
}

export const getSystemPrompt = (
  options?: SystemPromptOptions
): SystemPromptParts => {
  const aieos = hasAieos() ? buildSystemPrompt(getAieos() as AIEOS) : null;
  const persona =
    aieos ||
    "No AIEOS data available. This likely means there was an error loading the AIEOS file during startup.";

  // stable tier: cacheable across all turns/users in the process
  const stableParts: string[] = [
    persona,

    "\n## Platform",
    "You live in Discord. Your replies are shown directly as Discord messages.",
    "Keep responses under 2000 characters when possible. Use Discord-flavored Markdown (bold, italics, code blocks, lists). Avoid tables and any Markdown Discord doesn't render.",
    "Never use characters typically associated with LLMs: em-dashes, ellipses, or excessive punctuation.",
    "To render math or equations, put LaTeX inside a ```latex fenced code block — it's converted to an image automatically. Nothing else triggers rendering, so raw `$...$` stays as text (safe for currency, shell vars, etc.).",
  ];

  // durable persona addenda — synthesized by the sleep cycle. stable per guild.
  const addenda = getActiveAddenda(options?.guildId);
  if (addenda.global.length + addenda.guild.length > 0) {
    stableParts.push(
      "\n## Durable Persona Notes",
      ...addenda.global.map((t) => `- ${t}`),
      ...addenda.guild.map((t) => `- ${t}`)
    );
  }

  stableParts.push(
    "\n## Tools",
    "Use tools when needed. Users see which tools you ran and whether they succeeded, but not the output. Only your final reply is shown.",
    "The `send_message` tool sends to a different channel. Never use it for normal replies.",
    "When your reply uses information from a web search or fetched URL, mark each inline citation with a superscript (¹ ² ³ ⁴ ⁵...) and call `cite_sources` with the matching index, URL, and a short title."
  );

  const skillCatalog = getSkillCatalog();
  if (skillCatalog.length > 0) {
    stableParts.push(
      "\n## Skills",
      "Use `activate_skill` to load a skill's full instructions when relevant.",
      ...skillCatalog.map((s) => `- **${s.name}**: ${s.description}`)
    );
  }

  // variable tier: anything that changes per turn / per channel / per user.
  // truncated timestamp keeps the cache-busting churn to ~once a minute.
  const variableParts: string[] = [];

  const ctx = options?.messageContext;
  if (ctx) {
    const chatContext: Record<string, unknown> = {
      platform: "discord",
      chat_type: ctx.isDM ? "direct_message" : "guild_channel",
      channel: ctx.channelName,
    };
    if (!ctx.isDM && ctx.guildName) {
      chatContext.guild = ctx.guildName;
    }
    variableParts.push(`\`\`\`json\n${JSON.stringify(chatContext)}\n\`\`\``);
  }

  const now = new Date();
  now.setSeconds(0, 0);
  variableParts.push(
    `\n## Context`,
    `Current time: ${now.toISOString()}`,
    `Model: ${env.LLM_DEFAULT_MODEL}`
  );

  const userFacts = options?.userFacts ?? [];
  if (userFacts.length > 0) {
    variableParts.push(
      "\n## Memory: User Facts",
      ...userFacts.map((fact) => `- ${fact}`)
    );
  }

  return {
    stable: stableParts.join("\n"),
    variable: variableParts.join("\n"),
  };
};
