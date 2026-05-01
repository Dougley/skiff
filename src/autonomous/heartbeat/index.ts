import type { Client } from "discord.js";
import { MessageFlags } from "discord.js";
import { getHeartbeatChannels } from "../../db/queries.js";
import { handleConversationTurn } from "../../ai/llm/conversation-turn.js";
import { logger } from "../../config/logger.js";
import {
  getHeartbeatConfig,
  isWithinActiveHours,
  loadHeartbeatChecklist,
} from "./config.js";

let tickHandle: ReturnType<typeof setInterval> | null = null;

const HEARTBEAT_OK_MARKER = "HEARTBEAT_OK";

export function startHeartbeat(client: Client): void {
  const config = getHeartbeatConfig();

  if (!config.enabled) {
    logger.info("Heartbeat disabled via config");
    return;
  }

  if (tickHandle) return;

  logger.info("Heartbeat started", {
    intervalMinutes: config.intervalMs / 60000,
    quietHours: `${config.quietHoursStart}-${config.quietHoursEnd} (${config.timezone})`,
  });

  // Run first tick immediately, then on interval
  void tick(client);
  tickHandle = setInterval(() => void tick(client), config.intervalMs);
}

export function stopHeartbeat(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
    logger.info("Heartbeat stopped");
  }
}

async function tick(client: Client): Promise<void> {
  const config = getHeartbeatConfig();

  try {
    // Check quiet hours
    if (!isWithinActiveHours(config)) {
      logger.debug("Heartbeat skipped: outside active hours");
      return;
    }

    // Get all channels with heartbeat enabled
    const targets = await getHeartbeatChannels();
    if (targets.length === 0) {
      logger.debug("Heartbeat skipped: no channels enabled");
      return;
    }

    // Load checklist once (shared across all channels)
    const checklist = await loadHeartbeatChecklist(config.checklistPath);

    // Build heartbeat prompt
    const heartbeatPrompt = buildHeartbeatPrompt(checklist);

    logger.debug("Running heartbeat for channels", { count: targets.length });

    // Run heartbeat for each enabled channel
    for (const target of targets) {
      try {
        await runHeartbeatForChannel(client, target, heartbeatPrompt, config);
      } catch (err) {
        logger.error("Heartbeat error for channel", {
          channelId: target.channelId,
          err,
        });
        // Continue to next channel even if one fails
      }
    }
  } catch (err) {
    logger.error("Heartbeat tick error", { err });
  }
}

async function runHeartbeatForChannel(
  client: Client,
  target: { guildId: string | null; channelId: string },
  heartbeatPrompt: string,
  config: ReturnType<typeof getHeartbeatConfig>
): Promise<void> {
  // Fetch channel
  const channel = await client.channels.fetch(target.channelId);
  if (!channel?.isSendable()) {
    logger.warn("Heartbeat: channel not sendable", {
      channelId: target.channelId,
    });
    return;
  }

  // Run full LLM turn
  const result = await handleConversationTurn({
    content: heartbeatPrompt,
    userId: client.user?.id ?? "system",
    channelId: target.channelId,
    guildId: target.guildId,
    toolContext: {
      client,
      guildId: target.guildId,
      channelId: target.channelId,
      userId: null,
    },
    messageContext: {
      displayName: "Heartbeat",
      username: "system",
      channelName: "name" in channel ? `#${channel.name}` : "DM",
      guildName:
        target.guildId && "guild" in channel
          ? (channel.guild?.name ?? null)
          : null,
      isDM: channel.isDMBased(),
    },
    skipInitialStatus: true,
  });

  // Check if response should be suppressed
  const responseText = result.messages
    .flatMap((msg) => msg.components)
    .map((component) => {
      const json = component.toJSON();
      if ("content" in json && typeof json.content === "string") {
        return json.content;
      }
      return "";
    })
    .join("\n")
    .trim();

  const shouldSuppress = isHeartbeatOk(responseText, config.ackMaxChars);

  if (shouldSuppress) {
    logger.debug("Heartbeat: HEARTBEAT_OK received, suppressing output", {
      channelId: target.channelId,
    });
    return;
  }

  // Send response to channel
  for (const msg of result.messages) {
    await channel.send({
      flags: MessageFlags.IsComponentsV2,
      components: msg.components,
      files: msg.files,
    });
  }

  logger.info("Heartbeat: sent alert to channel", {
    channelId: target.channelId,
    usedTools: result.usedTools,
  });
}

function buildHeartbeatPrompt(checklist: string | null): string {
  let prompt = "[HEARTBEAT CHECK]\n\n";
  prompt +=
    "This is an automated heartbeat. Review the following and respond:\n\n";

  if (checklist) {
    prompt += "**Your standing instructions from HEARTBEAT.md:**\n\n";
    prompt += checklist;
    prompt += "\n\n";
  }

  prompt += "**Instructions:**\n";
  prompt += "- Use your tools to check on anything that needs monitoring\n";
  prompt +=
    "- If everything is fine and nothing needs attention, respond with exactly 'HEARTBEAT_OK' (at the start or end of your message)\n";
  prompt +=
    "- If you have something to report, omit 'HEARTBEAT_OK' and provide details\n";
  prompt += "- Stay in character and be concise\n";

  return prompt;
}

function isHeartbeatOk(text: string, maxChars: number): boolean {
  // Check if text contains HEARTBEAT_OK marker
  if (!text.includes(HEARTBEAT_OK_MARKER)) {
    return false;
  }

  // Remove the marker and check remaining content
  const withoutMarker = text
    .replace(new RegExp(HEARTBEAT_OK_MARKER, "g"), "")
    .trim();

  // If remaining content is short enough, suppress output
  return withoutMarker.length <= maxChars;
}
