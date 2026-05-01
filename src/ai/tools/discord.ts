import { tool } from "@ai-sdk/provider-utils";
import {
  ChannelType,
  type Client,
  type Guild,
  type GuildMember,
  type Message,
  MessageFlags,
  type TextBasedChannel,
} from "discord.js";
import { z } from "zod";
import { logger } from "../../config/logger.js";
import { markdownToDiscordComponents } from "../../utils/markdown-parser.js";

/**
 * Context passed to tool factories so tools know which guild/channel
 * the current conversation is happening in.
 */
export interface DiscordToolContext {
  client: Client;
  guildId: string | null;
  channelId: string;
  userId?: string | null;
  /**
   * Edit the current status message in-place.
   * Used by interactive tools (e.g. ask_questions) to replace the tool-tree
   * with custom content like select menus without sending new messages.
   * Returns the Message that was edited/created, or null on failure.
   */
  editStatusMessage?: (
    options: import("discord.js").MessageEditOptions
  ) => Promise<Message | null>;
}

// helpers

const resolveGuild = (ctx: DiscordToolContext): Guild | null =>
  ctx.guildId ? (ctx.client.guilds.cache.get(ctx.guildId) ?? null) : null;

const formatMember = (m: GuildMember) => ({
  id: m.id,
  username: m.user.username,
  displayName: m.displayName,
  bot: m.user.bot,
  roles: m.roles.cache.filter((r) => r.name !== "@everyone").map((r) => r.name),
  joinedAt: m.joinedAt?.toISOString() ?? null,
});

// tools

export const createDiscordTools = (ctx: DiscordToolContext) => ({
  /**
   * Get information about the current Discord server.
   */
  get_server_info: tool({
    description:
      "Get information about the current Discord server — name, member count, channels, and roles. Use this when the user asks about the server or you need context about where you are.",
    inputSchema: z.object({}),
    execute: async () => {
      const guild = resolveGuild(ctx);
      if (!guild) return { error: "Not in a server (DM context)." };

      const channels = guild.channels.cache.map((c) => ({
        id: c.id,
        name: c.name,
        type: ChannelType[c.type],
        ...(c.parentId
          ? { category: guild.channels.cache.get(c.parentId)?.name }
          : {}),
      }));

      const roles = guild.roles.cache
        .filter((r) => r.name !== "@everyone")
        .sort((a, b) => b.position - a.position)
        .map((r) => ({
          name: r.name,
          color: r.hexColor,
          memberCount: r.members.size,
        }));

      return {
        name: guild.name,
        id: guild.id,
        description: guild.description,
        memberCount: guild.memberCount,
        owner:
          guild.members.cache.get(guild.ownerId)?.displayName ?? guild.ownerId,
        createdAt: guild.createdAt.toISOString(),
        channels,
        roles,
      };
    },
  }),

  /**
   * Look up a member of the current server by username or display name.
   */
  get_user_info: tool({
    description:
      "Look up a Discord user in the current server by their username, display name, or user ID. Returns their roles, join date, and other profile info.",
    inputSchema: z.object({
      query: z
        .string()
        .describe("Username, display name, or user ID to search for."),
    }),
    execute: async ({ query }) => {
      const guild = resolveGuild(ctx);
      if (!guild) return { error: "Not in a server (DM context)." };

      // Try direct ID lookup first
      let member: GuildMember | undefined;
      if (/^\d{17,20}$/.test(query)) {
        try {
          member = await guild.members.fetch(query);
        } catch {
          // not found by ID, fall through to search
        }
      }

      if (!member) {
        // Search by username or display name
        const members = await guild.members.fetch({ query, limit: 5 });
        if (members.size === 0)
          return { error: `No member found matching "${query}".` };
        if (members.size === 1) {
          return formatMember(members.first() as GuildMember);
        } else {
          return {
            matches: members.map((m) => formatMember(m)),
            hint: "Multiple matches found. Ask the user to clarify which one.",
          };
        }
      }

      return formatMember(member);
    },
  }),

  /**
   * Read recent messages from a channel.
   */
  get_channel_messages: tool({
    description:
      "Fetch recent messages from a Discord channel. Defaults to the current channel. Useful for catching up on conversation context or finding something someone said.",
    inputSchema: z.object({
      channelId: z
        .string()
        .nullable()
        .describe(
          "Channel ID to read from. Leave null to use the current channel."
        ),
      limit: z
        .number()
        .min(1)
        .max(50)
        .nullable()
        .describe("Number of messages to fetch (1-50). Defaults to 20."),
    }),
    execute: async ({ channelId, limit }) => {
      const targetId = channelId ?? ctx.channelId;
      const count = limit ?? 20;

      let channel: TextBasedChannel | null = null;
      try {
        const fetched = await ctx.client.channels.fetch(targetId);
        if (!fetched?.isTextBased())
          return { error: "Channel is not a text channel." };
        channel = fetched as TextBasedChannel;
      } catch {
        return { error: `Could not fetch channel ${targetId}.` };
      }

      const messages = await channel.messages.fetch({ limit: count });
      return messages.reverse().map((m: Message) => ({
        id: m.id,
        author: m.author.username,
        authorId: m.author.id,
        content: m.content || null,
        embeds:
          m.embeds.length > 0
            ? m.embeds.map((e) => e.title ?? e.description ?? "(embed)")
            : undefined,
        attachments:
          m.attachments.size > 0 ? m.attachments.map((a) => a.url) : undefined,
        timestamp: m.createdAt.toISOString(),
      }));
    },
  }),

  /**
   * Add a reaction to a message.
   */
  react_to_message: tool({
    description:
      "Add an emoji reaction to a specific message. Use this to acknowledge something, respond non-verbally, or react to what someone said.",
    inputSchema: z.object({
      messageId: z.string().describe("The ID of the message to react to."),
      emoji: z
        .string()
        .describe(
          "The emoji to react with. Unicode emoji (e.g. '\u{1F44D}') or a custom emoji name."
        ),
      channelId: z
        .string()
        .nullable()
        .describe(
          "Channel the message is in. Leave null for the current channel."
        ),
    }),
    execute: async ({ messageId, emoji, channelId }) => {
      const targetId = channelId ?? ctx.channelId;
      try {
        const channel = await ctx.client.channels.fetch(targetId);
        if (!channel?.isTextBased()) return { error: "Not a text channel." };
        const message = await (channel as TextBasedChannel).messages.fetch(
          messageId
        );
        await message.react(emoji);
        return { success: true };
      } catch (err) {
        logger.warn("Failed to react", { messageId, emoji, err });
        return {
          error: `Failed to react: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  }),

  /**
   * Send a message to a specific channel (not the current conversation).
   */
  send_message: tool({
    description:
      "Send a message to a Discord channel other than the one you're currently talking in. Do NOT use this for normal replies — only for cross-channel communication when explicitly asked.",
    inputSchema: z.object({
      channelId: z
        .string()
        .describe("The target channel ID to send the message to."),
      content: z
        .string()
        .max(4000)
        .describe("The message content to send (max 4000 characters)."),
    }),
    execute: async ({ channelId, content }) => {
      if (channelId === ctx.channelId) {
        return {
          error:
            "Use your normal reply for the current channel. This tool is for cross-channel messages.",
        };
      }
      try {
        const channel = await ctx.client.channels.fetch(channelId);
        if (!channel?.isSendable())
          return { error: "Cannot send messages to this channel." };
        const sent = await channel.send({
          flags: MessageFlags.IsComponentsV2,
          components: markdownToDiscordComponents(content),
        });
        return { success: true, messageId: sent.id };
      } catch (err) {
        logger.warn("Failed to send cross-channel message", { channelId, err });
        return {
          error: `Failed to send: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  }),
});
