import { getAccessConfig, getDisabledToolGroups } from "../access/guard.js";
import { env } from "../env/index.js";
import { createAIEOSTools } from "./aieos.js";
import { createDiscordTools, type DiscordToolContext } from "./discord.js";
import { createHeartbeatTools } from "./heartbeat.js";
import { createToolset as createMCPToolset } from "./mcp.js";
import { createMemoryTools } from "./memory.js";
import { createSchedulerTools } from "./scheduler.js";
import { createShellTools } from "./shell.js";
import type { MCPClient } from "@ai-sdk/mcp";
import { createSkillTools } from "./skills.js";
import { createTopicTools } from "./topic.js";
import { createUserInputTools } from "./user-input.js";
import { createWebTools } from "./web.js";

/**
 * Build the full tool set for a conversation turn.
 * Called per-request so tools have access to the current guild/channel context.
 * Tool groups can be disabled per guild, channel, user, or DM via TOOL_*_RULES.
 */
export async function createToolSet(
  ctx: DiscordToolContext,
  pendingSkillTools: Record<string, unknown>,
  openClients: MCPClient[]
) {
  const disabled = getDisabledToolGroups(
    {
      guildId: ctx.guildId,
      channelId: ctx.channelId,
      userId: ctx.userId ?? null,
      isDM: !ctx.guildId,
    },
    getAccessConfig()
  );

  return {
    ...(!disabled.has("discord") ? createDiscordTools(ctx) : {}),
    ...(!disabled.has("aieos") ? createAIEOSTools() : {}),
    ...(!disabled.has("memory") ? createMemoryTools(ctx) : {}),
    ...(!disabled.has("topic") ? createTopicTools(ctx) : {}),
    ...(!disabled.has("web") ? createWebTools() : {}),
    ...(!disabled.has("scheduler") ? createSchedulerTools(ctx) : {}),
    ...(!disabled.has("heartbeat") ? createHeartbeatTools(ctx) : {}),
    ...(env.SHELL_ENABLED && !disabled.has("shell") ? createShellTools() : {}),
    ...(!disabled.has("mcp") ? await createMCPToolset() : {}),
    ...(!disabled.has("user-input") ? createUserInputTools(ctx) : {}),
    ...(!disabled.has("skills") ? createSkillTools(pendingSkillTools, openClients) : {}),
  };
}
