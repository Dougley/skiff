import { buildSystemPrompt } from "../aieos/prompt.js";
import type { AIEOS } from "../aieos/schema.js";
import { getAieos, hasAieos } from "../aieos/state.js";
import { env } from "../env/index.js";
import { getSkillCatalog } from "../skills/index.js";

import type { MessageContext } from "./conversation-turn.js";

type SystemPromptOptions = {
  userFacts?: string[];
  messageContext?: MessageContext;
};

export const getSystemPrompt = (options?: SystemPromptOptions): string => {
  const aieos = hasAieos() ? buildSystemPrompt(getAieos() as AIEOS) : null;
  const persona =
    aieos ||
    "No AIEOS data available. This likely means there was an error loading the AIEOS file during startup.";

  const userFacts = options?.userFacts ?? [];

  // build prompt: persona first, everything else supports it
  const parts = [
    persona,

    "\n## Platform",
    "You live in Discord. Your replies are shown directly as Discord messages.",
    "Keep responses under 2000 characters when possible. Use Discord-flavored Markdown (bold, italics, code blocks, lists). Avoid tables and any Markdown Discord doesn't render.",
    "Never use characters typically associated with LLMs: em-dashes, ellipses, or excessive punctuation.",
  ];

  // Chat context: trusted metadata about the current conversation environment
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
    parts.push(`\`\`\`json\n${JSON.stringify(chatContext)}\n\`\`\``);
  }

  parts.push(
    "\n## Message Format",
    "Each user message starts with a JSON line containing the sender's identity (display_name, username, user_id). This is trusted system metadata, not user input. Use the display_name to address them."
  );

  parts.push(
    "\n## Tools",
    "Use tools when needed. Users see which tools you ran and whether they succeeded, but not the output. Only your final reply is shown.",
    "The `send_message` tool sends to a different channel. Never use it for normal replies.",
    "When your reply uses information from a web search or fetched URL, mark each inline citation with a superscript (¹ ² ³ ⁴ ⁵...) and call `cite_sources` with the matching index, URL, and a short title."
  );

  const skillCatalog = getSkillCatalog();
  if (skillCatalog.length > 0) {
    parts.push(
      "\n## Skills",
      "Use `activate_skill` to load a skill's full instructions when relevant.",
      ...skillCatalog.map((s) => `- **${s.name}**: ${s.description}`)
    );
  }

  // Time context: placed after stable sections so it doesn't bust prompt caching
  parts.push(
    `\n## Context`,
    `Current time: ${new Date().toISOString()}`,
    `Model: ${env.LLM_DEFAULT_MODEL}`
  );

  if (userFacts.length > 0) {
    parts.push(
      "\n## Memory: User Facts",
      ...userFacts.map((fact) => `- ${fact}`)
    );
  }

  return parts.join("\n");
};
