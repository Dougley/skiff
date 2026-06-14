import type { EnvironmentVariables } from "./env-schema.js";

export type ToolGroup =
  | "discord"
  | "persona"
  | "memory"
  | "topic"
  | "web"
  | "scheduler"
  | "heartbeat"
  | "shell"
  | "mcp"
  | "user-input"
  | "skills";

export interface AccessConfig {
  policy: "open" | "disabled" | "allowlist";
  dmPolicy: "open" | "disabled" | "allowlist";
  allowedGuilds: Set<string>;
  allowedChannels: Set<string>;
  allowedUsers: Set<string>;
  toolChannelRules: Map<string, Set<ToolGroup>>;
  toolGuildRules: Map<string, Set<ToolGroup>>;
  toolDmRules: Set<ToolGroup>;
  toolUserRules: Map<string, Set<ToolGroup>>;
}

export interface AccessContext {
  guildId: string | null;
  channelId: string;
  userId: string;
  isDM: boolean;
}

export interface AccessResult {
  allowed: boolean;
  reason?: string;
}

function parseCommaSeparated(value: string): Set<string> {
  const items = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return new Set(items);
}

const VALID_TOOL_GROUPS = new Set<ToolGroup>([
  "discord",
  "persona",
  "memory",
  "topic",
  "web",
  "scheduler",
  "heartbeat",
  "shell",
  "mcp",
  "user-input",
  "skills",
]);

/**
 * Parse rules in the format "id:group1,group2;id2:group3".
 * Returns a Map from ID to disabled tool groups.
 */
function parseToolRules(value: string): Map<string, Set<ToolGroup>> {
  const rules = new Map<string, Set<ToolGroup>>();
  if (!value.trim()) return rules;

  for (const rule of value.split(";")) {
    const trimmed = rule.trim();
    if (!trimmed) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const id = trimmed.slice(0, colonIdx).trim();
    const groups = trimmed
      .slice(colonIdx + 1)
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is ToolGroup => VALID_TOOL_GROUPS.has(s as ToolGroup));

    if (id && groups.length > 0) {
      rules.set(id, new Set(groups));
    }
  }

  return rules;
}

/**
 * Parse a flat comma-separated list of tool groups (no ID prefix).
 * Used for TOOL_DM_RULES which applies globally to all DMs.
 */
function parseToolGroupList(value: string): Set<ToolGroup> {
  if (!value.trim()) return new Set();
  return new Set(
    value
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is ToolGroup => VALID_TOOL_GROUPS.has(s as ToolGroup))
  );
}

export function parseAccessConfig(env: EnvironmentVariables): AccessConfig {
  return {
    policy: env.ACCESS_POLICY,
    dmPolicy: env.ACCESS_DM_POLICY,
    allowedGuilds: parseCommaSeparated(env.ACCESS_ALLOWED_GUILDS),
    allowedChannels: parseCommaSeparated(env.ACCESS_ALLOWED_CHANNELS),
    allowedUsers: parseCommaSeparated(env.ACCESS_ALLOWED_USERS),
    toolChannelRules: parseToolRules(env.TOOL_CHANNEL_RULES),
    toolGuildRules: parseToolRules(env.TOOL_GUILD_RULES),
    toolDmRules: parseToolGroupList(env.TOOL_DM_RULES),
    toolUserRules: parseToolRules(env.TOOL_USER_RULES),
  };
}

let cachedConfig: AccessConfig | null = null;

export function initAccessConfig(env: EnvironmentVariables): AccessConfig {
  cachedConfig = parseAccessConfig(env);
  return cachedConfig;
}

export function getAccessConfig(): AccessConfig {
  if (!cachedConfig) {
    throw new Error(
      "Access config not initialized. Call initAccessConfig() first."
    );
  }
  return cachedConfig;
}

export function checkAccess(
  ctx: AccessContext,
  config: AccessConfig
): AccessResult {
  if (ctx.isDM) {
    switch (config.dmPolicy) {
      case "open":
        return { allowed: true };
      case "disabled":
        return { allowed: false, reason: "DMs are disabled" };
      case "allowlist":
        if (
          config.allowedUsers.size > 0 &&
          !config.allowedUsers.has(ctx.userId)
        ) {
          return { allowed: false, reason: "User not in DM allowlist" };
        }
        return { allowed: true };
    }
  }

  switch (config.policy) {
    case "open":
      return { allowed: true };
    case "disabled":
      return { allowed: false, reason: "Bot is disabled" };
    case "allowlist": {
      if (
        config.allowedGuilds.size > 0 &&
        (!ctx.guildId || !config.allowedGuilds.has(ctx.guildId))
      ) {
        return { allowed: false, reason: "Guild not in allowlist" };
      }
      if (
        config.allowedChannels.size > 0 &&
        !config.allowedChannels.has(ctx.channelId)
      ) {
        return { allowed: false, reason: "Channel not in allowlist" };
      }
      if (
        config.allowedUsers.size > 0 &&
        !config.allowedUsers.has(ctx.userId)
      ) {
        return { allowed: false, reason: "User not in allowlist" };
      }
      return { allowed: true };
    }
  }
}

export interface ToolContext {
  guildId: string | null;
  channelId: string;
  userId: string | null;
  isDM: boolean;
}

export function getDisabledToolGroups(
  ctx: ToolContext,
  config: AccessConfig
): Set<ToolGroup> {
  const disabled = new Set<ToolGroup>();

  // DM-wide rules
  if (ctx.isDM) {
    for (const group of config.toolDmRules) {
      disabled.add(group);
    }
  }

  // Guild-wide defaults
  if (ctx.guildId) {
    const guildRules = config.toolGuildRules.get(ctx.guildId);
    if (guildRules) {
      for (const group of guildRules) {
        disabled.add(group);
      }
    }
  }

  // Channel-specific overrides
  const channelRules = config.toolChannelRules.get(ctx.channelId);
  if (channelRules) {
    for (const group of channelRules) {
      disabled.add(group);
    }
  }

  // User-specific restrictions
  if (ctx.userId) {
    const userRules = config.toolUserRules.get(ctx.userId);
    if (userRules) {
      for (const group of userRules) {
        disabled.add(group);
      }
    }
  }

  return disabled;
}
