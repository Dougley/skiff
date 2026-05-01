import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Events, Listener } from "@sapphire/framework";
import {
  type Attachment,
  type Collection,
  type Message,
  MessageFlags,
  TextDisplayBuilder,
} from "discord.js";
import { checkAccess, getAccessConfig } from "../../config/access.js";
import { env } from "../../config/env.js";
import { handleConversationTurn, type ImageAttachment } from "../../ai/llm/conversation-turn.js";
import { logger } from "../../config/logger.js";

const IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

// download attachments to SHELL_WORK_DIR/attachments/, return content lines + disk paths for cleanup
async function downloadAttachments(
  messageId: string,
  attachments: Collection<string, Attachment>
): Promise<{ lines: string[]; paths: string[]; images: ImageAttachment[] }> {
  const dir = path.join(env.SHELL_WORK_DIR, "attachments");
  await fs.mkdir(dir, { recursive: true });

  const lines: string[] = [];
  const paths: string[] = [];
  const images: ImageAttachment[] = [];

  for (const att of attachments.values()) {
    const ext = path.extname(att.name ?? "");
    const filename = `${messageId}-${att.id}${ext}`;
    const filepath = path.join(dir, filename);

    try {
      const res = await fetch(att.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.writeFile(filepath, buf);
      paths.push(filepath);
      const meta = [att.contentType, att.size ? `${att.size} bytes` : null]
        .filter(Boolean)
        .join(", ");
      lines.push(
        `[Attachment: ${att.name ?? filename} → ${filepath}${meta ? ` (${meta})` : ""}]`
      );
      if (att.contentType && IMAGE_CONTENT_TYPES.has(att.contentType)) {
        images.push({
          mediaType: att.contentType,
          data: buf,
          name: att.name ?? filename,
        });
      }
    } catch (err) {
      logger.warn("Failed to download attachment", { url: att.url, err });
      lines.push(
        `[Attachment: ${att.name ?? "unknown"} — download failed, available at: ${att.url}]`
      );
    }
  }

  return { lines, paths, images };
}

export class MessagesListener extends Listener {
  public constructor(
    context: Listener.LoaderContext,
    options: Listener.Options
  ) {
    super(context, {
      ...options,
      event: Events.MessageCreate,
    });
  }

  public async run(message: Message) {
    if (message.author.bot) return;

    const botId = this.container.client.user?.id;
    if (!botId) return;

    const isDM = message.channel.isDMBased();
    const isMentioned = message.mentions.has(botId);

    let isReplyToBot = false;
    let replyContext: string | null = null;
    if (message.reference) {
      try {
        const replied = await message.fetchReference();
        isReplyToBot = replied.author.id === botId;
        if (replied.content) {
          replyContext = replied.content;
        }
      } catch {
        // Reference message may have been deleted
      }
    }

    if (!isDM && !isMentioned && !isReplyToBot) return;

    const accessResult = checkAccess(
      {
        guildId: message.guildId,
        channelId: message.channelId,
        userId: message.author.id,
        isDM,
      },
      getAccessConfig()
    );

    if (!accessResult.allowed) {
      logger.debug("Access denied for message", {
        userId: message.author.id,
        channelId: message.channelId,
        reason: accessResult.reason,
      });
      return;
    }

    // Strip bot mention from content so the LLM gets clean text
    let content = message.content
      .replace(new RegExp(`<@!?${botId}>`, "g"), "")
      .trim();

    // If replying to a message, include it as context
    if (replyContext) {
      content = `[Replying to: "${replyContext}"]\n\n${content}`;
    }

    if (!content && message.attachments.size === 0) return;

    // download any attachments and append info to content so the agent can access them
    let downloadedPaths: string[] = [];
    let attachmentImages: ImageAttachment[] = [];
    if (message.attachments.size > 0) {
      const { lines, paths, images } = await downloadAttachments(
        message.id,
        message.attachments
      );
      downloadedPaths = paths;
      attachmentImages = images;
      if (lines.length > 0) {
        const block = lines.join("\n");
        content = content ? `${content}\n\n${block}` : block;
      }
    }

    logger.info(
      `Received message from user ${message.author.id} in guild ${message.guildId}, channel ${message.channelId}`
    );

    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping();
    }

    try {
      const status: {
        message: Message | null;
        pending: Promise<Message | null> | null;
      } = {
        message: null,
        pending: null,
      };

      const channelName =
        "name" in message.channel ? `#${message.channel.name}` : "DM";
      const member = message.member;

      const result = await handleConversationTurn({
        content,
        userId: message.author.id,
        channelId: message.channelId,
        guildId: message.guildId,
        images: attachmentImages.length > 0 ? attachmentImages : undefined,
        toolContext: {
          client: this.container.client,
          guildId: message.guildId,
          channelId: message.channelId,
          userId: message.author.id,
          async editStatusMessage(options) {
            try {
              if (status.pending) await status.pending;
              if (status.message) {
                await status.message.edit(options);
                return status.message;
              }
              // First status message — use reply() with only the fields
              // that are compatible with MessageReplyOptions.
              const msg = await message.reply({
                content: options.content ?? undefined,
                components: options.components as never,
              });
              status.message = msg;
              return msg;
            } catch (err) {
              logger.warn("Failed to edit status message", { err });
              return null;
            }
          },
        },
        messageContext: {
          displayName: member?.displayName ?? message.author.displayName,
          username: message.author.username,
          channelName,
          guildName: message.guild?.name ?? null,
          isDM,
        },
        onToolStatus(statusText) {
          if (status.message) {
            status.message
              .edit({
                flags: MessageFlags.IsComponentsV2,
                components: [new TextDisplayBuilder().setContent(statusText)],
              })
              .catch((err) =>
                logger.warn("Failed to update tool status", { err })
              );
          } else if (!status.pending) {
            status.pending = message
              .reply({
                flags: MessageFlags.IsComponentsV2,
                components: [new TextDisplayBuilder().setContent(statusText)],
              })
              .then((msg) => {
                status.message = msg;
                return msg;
              })
              .catch((err) => {
                logger.warn("Failed to send tool status", { err });
                return null;
              });
          }
        },
      });

      // Wait for any in-flight status reply to resolve
      if (status.pending) {
        await status.pending;
      }

      const [first, ...rest] = result.messages;
      if (!first) {
        await message.reply("I had nothing to say.");
      } else if (status.message) {
        await status.message.edit({
          flags: MessageFlags.IsComponentsV2,
          components: first.components,
          files: first.files,
        });
      } else {
        await message.reply({
          flags: MessageFlags.IsComponentsV2,
          components: first.components,
          files: first.files,
        });
      }

      for (const chunk of rest) {
        await message.reply({
          flags: MessageFlags.IsComponentsV2,
          components: chunk.components,
          files: chunk.files,
        });
      }

      logger.info(
        `Replied to message ${message.id} from user ${message.author.id} with assistant response, convo length so far: ${result.historyLength} messages`
      );
    } catch (err) {
      logger.error("MessageCreate: chat failed", { err });
      await message.reply("Something went wrong — try again in a moment.");
    } finally {
      // clean up downloaded attachments now that the turn is done
      void Promise.all(
        downloadedPaths.map((p) => fs.unlink(p).catch(() => {}))
      );
    }
  }
}
