import { tool } from "ai";
import { z } from "zod";
import {
  disableHeartbeatForChannel,
  enableHeartbeatForChannel,
  isHeartbeatEnabledForChannel,
} from "../../db/queries.js";
import type { DiscordToolContext } from "./discord.js";

export const createHeartbeatTools = (ctx: DiscordToolContext) => ({
  enable_heartbeat: tool({
    description:
      "Enable heartbeat monitoring for the current channel. The bot will periodically check in " +
      "and run autonomous monitoring tasks defined in HEARTBEAT.md.",
    inputSchema: z.object({}),
    execute: async () => {
      await enableHeartbeatForChannel(ctx.guildId, ctx.channelId);
      return {
        success: true,
        message:
          "Heartbeat enabled for this channel. I'll check in periodically.",
      };
    },
  }),

  disable_heartbeat: tool({
    description:
      "Disable heartbeat monitoring for the current channel. The bot will stop autonomous check-ins.",
    inputSchema: z.object({}),
    execute: async () => {
      await disableHeartbeatForChannel(ctx.channelId);
      return {
        success: true,
        message:
          "Heartbeat disabled for this channel. I'll only respond when mentioned.",
      };
    },
  }),

  heartbeat_status: tool({
    description:
      "Check if heartbeat monitoring is enabled for the current channel.",
    inputSchema: z.object({}),
    execute: async () => {
      const enabled = await isHeartbeatEnabledForChannel(ctx.channelId);
      return {
        enabled,
        message: enabled
          ? "Heartbeat is enabled for this channel."
          : "Heartbeat is disabled for this channel.",
      };
    },
  }),
});
