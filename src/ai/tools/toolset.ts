import type { MCPClient } from "@ai-sdk/mcp";
import {
  getAccessConfig,
  getDisabledToolGroups,
  getDisabledToolNames,
} from "../../config/access.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { createDiscordTools, type DiscordToolContext } from "./discord.js";
import { createHeartbeatTools } from "./heartbeat.js";
import { createLogbookTools } from "./logbook.js";
import { createToolset as createMCPToolset } from "./mcp.js";
import { createMemoryTools } from "./memory.js";
import { createPersonaTools } from "./persona.js";
import { createSchedulerTools } from "./scheduler.js";
import { createShellTools } from "./shell.js";
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

  const disabledNames = getDisabledToolNames(getAccessConfig());

  const allBuiltins: Record<string, unknown> = {
    ...(!disabled.has("discord") ? createDiscordTools(ctx) : {}),
    ...(!disabled.has("persona") ? createPersonaTools(ctx) : {}),
    ...(!disabled.has("memory") ? createMemoryTools(ctx) : {}),
    ...(!disabled.has("topic") ? createTopicTools(ctx) : {}),
    ...(!disabled.has("web") ? createWebTools(ctx) : {}),
    ...(!disabled.has("scheduler") ? createSchedulerTools(ctx) : {}),
    ...(!disabled.has("heartbeat") ? createHeartbeatTools(ctx) : {}),
    ...(!disabled.has("logbook") ? createLogbookTools(ctx) : {}),
    ...(env.SHELL_ENABLED && !disabled.has("shell") ? createShellTools() : {}),
    ...(!disabled.has("user-input") ? createUserInputTools(ctx) : {}),
    ...(!disabled.has("skills")
      ? createSkillTools(pendingSkillTools, openClients)
      : {}),
  };

  // DISABLED_TOOLS names built-ins only, and dropping them BEFORE the MCP
  // merge is the point rather than a detail: a disabled built-in frees its
  // name, so a replacement MCP tool can claim it outright instead of landing
  // under the mcp_ prefix below. Do not fold this into a filter after the
  // merge — that would block the replacement along with the original.
  // (MCP tools are governed by mcp.json and the `mcp` group.)
  const builtins = Object.fromEntries(
    Object.entries(allBuiltins).filter(([name]) => !disabledNames.has(name))
  );

  if (disabled.has("mcp")) return builtins;

  // MCP tools may never shadow built-ins: a colliding name is exposed under
  // an mcp_ prefix instead, and dropped if even that collides
  const tools = { ...builtins };
  for (const [name, mcpTool] of Object.entries(await createMCPToolset())) {
    if (!(name in tools)) {
      tools[name] = mcpTool;
      continue;
    }
    const renamed = `mcp_${name}`;
    if (renamed in tools) {
      logger.warn(
        `MCP tool "${name}" dropped: both its name and "${renamed}" collide with existing tools`
      );
      continue;
    }
    logger.warn(
      `MCP tool "${name}" collides with a built-in tool — exposing it as "${renamed}"`
    );
    tools[renamed] = mcpTool;
  }
  return tools;
}
