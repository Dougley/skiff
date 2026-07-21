import type { ImagePart, ModelMessage } from "@ai-sdk/provider-utils";
import { container } from "@sapphire/framework";
import {
  AttachmentBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from "discord.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import {
  getLastAssistantInputTokens,
  getOrCreateConversation,
  getRecentMessages,
  insertMessage,
} from "../../db/queries.js";
import { EMOJI } from "../../utils/emoji.js";
import { renderLatex } from "../../utils/latex.js";
import {
  markdownToDiscordComponents,
  type ParsedMessage,
  splitComponentMessages,
  splitComponentMessagesWithFiles,
} from "../../utils/markdown-parser.js";
import {
  formatContextUsage,
  formatToolStatusMessage,
} from "../../utils/tool-status.js";
import { compactConversation, shouldCompact } from "../memory/compaction.js";
import { enqueueEmbedding } from "../memory/embeddings.js";
import { enqueueMemoryExtraction } from "../memory/extract.js";
import type { DiscordToolContext } from "../tools/discord.js";
import { formatSourceRef } from "../tools/sources.js";
import {
  ContextWindowFullError,
  chat as chatWithLLM,
  type ToolActivityEvent,
} from "./streaming.js";
import type { MessageContext } from "./types.js";

// types

export type { MessageContext };

export interface ImageAttachment {
  mediaType: string;
  data: Buffer;
  name: string;
}

export interface ConversationTurnParams {
  /** The user's input text. */
  content: string;
  /** Discord user ID. */
  userId: string;
  /** Channel ID for conversation lookup. */
  channelId: string;
  /** Guild ID (null for DMs). */
  guildId: string | null;
  /** Tool context for the LLM. */
  toolContext: DiscordToolContext;
  /** Discord metadata about the sender and channel. */
  messageContext: MessageContext;
  /** Image attachments to send as vision content (only sent if VISION_ENABLED). */
  images?: ImageAttachment[];
  /**
   * Called (debounced) when tool activity updates occur.
   * Receives the formatted status text to display.
   */
  onToolStatus?: (statusText: string) => void;
  /**
   * When true, skip the immediate "thinking" indicator because the caller
   * already shows its own loading state (e.g. a deferred slash-command reply).
   */
  skipInitialStatus?: boolean;
  /**
   * When true, skip embedding and fact extraction for this turn. Used by
   * system-initiated turns (heartbeat, scheduler) so their prompts don't
   * pollute semantic memory.
   */
  skipMemory?: boolean;
}

export interface ConversationTurnResult {
  /** The response split into message-sized chunks with their attachments. */
  messages: ParsedMessage[];
  /** The raw final text from the model, before Discord rendering. */
  text: string;
  /** Whether any tools were called during this turn. */
  usedTools: boolean;
  /** Number of messages in the conversation history (including this turn). */
  historyLength: number;
}

const DEBOUNCE_MS = 800;

// resolve /clear as a clickable Discord command mention, falling back to plain text
function clearMention(guildId: string | null): string {
  const cmd = container.stores.get("commands").get("clear");
  if (!cmd) return "`/clear`";
  const reg = cmd.applicationCommandRegistry;
  const id =
    (guildId &&
      reg.guildIdToChatInputCommandIds.get(guildId)?.values().next().value) ??
    reg.globalChatInputCommandIds.values().next().value;
  return id ? `</clear:${id}>` : "`/clear`";
}

// helpers

// reconstruct AI SDK ModelMessage[] from DB rows, preserving tool call/result structure
function historyToMessages(
  history: Awaited<ReturnType<typeof getRecentMessages>>
): ModelMessage[] {
  return history.map((m): ModelMessage => {
    if (m.role === "tool") {
      return { role: "tool", content: m.toolResults ?? [] };
    }
    if (m.toolCalls) {
      const parts: Exclude<
        Extract<ModelMessage, { role: "assistant" }>["content"],
        string
      > = [];
      if (m.content) parts.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) parts.push(tc);
      return { role: "assistant", content: parts };
    }
    return { role: m.role as "user" | "assistant", content: m.content ?? "" };
  });
}

// main

// run a full conversation turn: persist user message, call LLM, persist reply,
// enqueue embedding + memory extraction, return final Discord components
export async function handleConversationTurn(
  params: ConversationTurnParams
): Promise<ConversationTurnResult> {
  const {
    content,
    userId,
    channelId,
    guildId,
    toolContext,
    messageContext,
    images,
    onToolStatus,
    skipInitialStatus,
    skipMemory,
  } = params;

  // conversation & history (rows already folded into the compaction summary
  // are excluded; the summary itself is injected into the system prompt)
  const conversation = await getOrCreateConversation({ channelId, guildId });
  const history = await getRecentMessages(
    conversation.id,
    undefined,
    conversation.summaryUpToMessageId
  );
  const priorInputTokens = await getLastAssistantInputTokens(conversation.id);

  // persist user message
  const userMsg = await insertMessage({
    conversationId: conversation.id,
    role: "user",
    content,
    userId,
  });

  if (!skipMemory) {
    void enqueueEmbedding({
      messageId: userMsg.id,
      conversationId: conversation.id,
      channelId,
      userId,
      guildId,
      content,
    });
  }

  // LLM call with debounced tool status
  const toolEvents: ToolActivityEvent[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // cite_sources is an internal tool — keep it out of every user-facing view
  const isVisibleEvent = (e: ToolActivityEvent) =>
    e.type !== "tool" || e.toolName !== "cite_sources";

  // Show an immediate "thinking" indicator so the user knows we're working
  // (skipped for slash commands where the deferred reply already shows a loading state)
  if (!skipInitialStatus) {
    onToolStatus?.(formatToolStatusMessage([], false));
  }

  const onToolActivity = (event: ToolActivityEvent) => {
    toolEvents.push(event);
    if (!onToolStatus) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      onToolStatus(
        formatToolStatusMessage(toolEvents.filter(isVisibleEvent), false)
      );
    }, DEBOUNCE_MS);
  };

  // Build a structured JSON sender block so the LLM knows who's talking
  const senderMeta = JSON.stringify({
    sender: {
      display_name: messageContext.displayName,
      username: messageContext.username,
      user_id: userId,
    },
  });

  const imageParts: ImagePart[] =
    env.VISION_ENABLED && images && images.length > 0
      ? images.map((img) => ({
          type: "image" as const,
          image: img.data,
          mediaType: img.mediaType,
        }))
      : [];

  const currentUserMessage: ModelMessage =
    imageParts.length > 0
      ? {
          role: "user" as const,
          content: [
            { type: "text" as const, text: `${senderMeta}\n${content}` },
            ...imageParts,
          ],
        }
      : { role: "user" as const, content: `${senderMeta}\n${content}` };

  const runChat = (
    hist: Awaited<ReturnType<typeof getRecentMessages>>,
    summary: string | null,
    priorTokens: number | null
  ) =>
    chatWithLLM({
      messages: [...historyToMessages(hist), currentUserMessage],
      userId,
      toolContext,
      messageContext,
      onToolActivity,
      priorInputTokens: priorTokens,
      conversationSummary: summary,
    });

  // when the context wall is hit, compact the history into the rolling
  // summary and retry once; only give up if even that doesn't fit
  const retryAfterCompaction = async () => {
    if (!(await compactConversation(conversation.id))) return null;
    const fresh = await getOrCreateConversation({ channelId, guildId });
    const freshHistory = await getRecentMessages(
      conversation.id,
      undefined,
      fresh.summaryUpToMessageId,
      userMsg.id
    );
    try {
      return await runChat(freshHistory, fresh.summary, null);
    } catch (retryErr) {
      if (retryErr instanceof ContextWindowFullError) return null;
      throw retryErr;
    }
  };

  let result: Awaited<ReturnType<typeof chatWithLLM>>;
  try {
    result = await runChat(history, conversation.summary, priorInputTokens);
  } catch (err) {
    if (!(err instanceof ContextWindowFullError)) {
      if (debounceTimer) clearTimeout(debounceTimer);
      throw err;
    }
    if (!err.retrySafe) {
      if (debounceTimer) clearTimeout(debounceTimer);
      const notice =
        "I completed part of the requested work, but the conversation ran out of context before I could produce a final response. I did not retry because that could repeat tool actions. Use " +
        `${clearMention(guildId)} before trying again.`;
      const components = markdownToDiscordComponents(notice);
      return {
        messages: splitComponentMessagesWithFiles(components, []),
        text: notice,
        usedTools: toolEvents.some((event) => event.type === "tool"),
        historyLength: history.length + 1,
      };
    }
    logger.info("context window full — compacting and retrying", {
      channelId,
    });
    const recovered = await retryAfterCompaction();
    if (!recovered) {
      if (debounceTimer) clearTimeout(debounceTimer);
      const notice = `The conversation is too long for me to continue. Use ${clearMention(guildId)} to start a fresh conversation.`;
      const components = markdownToDiscordComponents(notice);
      return {
        messages: splitComponentMessagesWithFiles(components, []),
        text: notice,
        usedTools: false,
        historyLength: history.length + 1,
      };
    }
    result = recovered;
  }

  // Cancel any pending debounce so it doesn't fire after we send the response
  if (debounceTimer) clearTimeout(debounceTimer);

  // persist all response messages (assistant tool-calls + tool results + final text)
  let assistantMsg: Awaited<ReturnType<typeof insertMessage>> | undefined;

  for (const msg of result.responseMessages) {
    if (msg.role === "assistant") {
      // Assistant messages may contain text, tool calls, or both.
      // Content can be a plain string or an array of content parts.
      if (typeof msg.content === "string") {
        assistantMsg = await insertMessage({
          conversationId: conversation.id,
          role: "assistant",
          content: msg.content || null,
          lastInputTokens: result.lastInputTokens,
        });
      } else {
        const textParts = msg.content.filter((p) => p.type === "text");
        const toolCallParts = msg.content.filter((p) => p.type === "tool-call");
        const textContent =
          textParts
            .map((p) => (p.type === "text" ? p.text : ""))
            .join("")
            .trim() || null;

        assistantMsg = await insertMessage({
          conversationId: conversation.id,
          role: "assistant",
          content: textContent,
          toolCalls: toolCallParts.length > 0 ? toolCallParts : null,
          lastInputTokens: result.lastInputTokens,
        });
      }
    } else if (msg.role === "tool") {
      // Tool result messages
      await insertMessage({
        conversationId: conversation.id,
        role: "tool",
        content: null,
        toolResults: msg.content,
      });
    }
  }

  // Fallback: if no assistant message was persisted (shouldn't happen), create one
  if (!assistantMsg) {
    assistantMsg = await insertMessage({
      conversationId: conversation.id,
      role: "assistant",
      content: result.text,
      lastInputTokens: result.lastInputTokens,
    });
  }

  if (!skipMemory) {
    void enqueueEmbedding({
      messageId: assistantMsg.id,
      conversationId: conversation.id,
      channelId,
      userId,
      guildId,
      content: result.text,
    });

    void enqueueMemoryExtraction({
      userText: content,
      assistantText: result.text,
      userId,
      guildId,
      channelId,
      conversationId: conversation.id,
      sourceMessageId: assistantMsg.id,
    });
  }

  // build response components & split into message-sized chunks
  const { text: latexText, files: latexFiles } = await renderLatex(result.text);
  const components = markdownToDiscordComponents(latexText);
  const messages = splitComponentMessagesWithFiles(components, latexFiles);

  // Build footer (tool summary + sources + context warning) and append to messages.
  // Footer components are run through splitComponentMessages to respect Discord limits,
  // then merged into the last content chunk if they fit, or sent as a trailing chunk.
  const visibleToolEvents = toolEvents.filter(isVisibleEvent);
  const hasToolCalls = visibleToolEvents.some((e) => e.type === "tool");
  const contextWarning = formatContextUsage(result.lastInputTokens);
  if (hasToolCalls || result.sources.length > 0 || contextWarning) {
    const footerParts: string[] = [];
    if (hasToolCalls) {
      footerParts.push(formatToolStatusMessage(visibleToolEvents, true));
    }
    if (result.sources.length > 0) {
      footerParts.push(`\n-# ${EMOJI.internet} Sources:\n`);
      footerParts.push(result.sources.map(formatSourceRef).join("\n"));
    }
    if (contextWarning) {
      footerParts.push(contextWarning);
    }
    const footerText = footerParts.join("\n");
    const footerComponents = [
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
      ...markdownToDiscordComponents(footerText),
    ];
    const footerChunks = splitComponentMessages(footerComponents);

    const last = messages[messages.length - 1];
    const onlyFooterChunk = footerChunks.length === 1 ? footerChunks[0] : null;
    if (
      last &&
      onlyFooterChunk &&
      last.components.length + onlyFooterChunk.length <= 40 &&
      last.components
        .filter((c) => c instanceof TextDisplayBuilder)
        .reduce((sum, c) => sum + c.toJSON().content.length, 0) +
        onlyFooterChunk
          .filter((c) => c instanceof TextDisplayBuilder)
          .reduce((sum, c) => sum + c.toJSON().content.length, 0) <=
        4000
    ) {
      // fits in the last chunk
      last.components.push(...onlyFooterChunk);
    } else {
      // doesn't fit — append as many valid trailing chunks as needed
      messages.push(
        ...footerChunks.map((components) => ({ components, files: [] }))
      );
    }
  }

  // attach tool-produced files (screenshots etc.) to the reply
  if (result.attachments.length > 0) {
    const builders = result.attachments.map(
      (a) => new AttachmentBuilder(a.data, { name: a.name })
    );
    const last = messages[messages.length - 1];
    let nextAttachment = 0;

    // Use any capacity left on the final text message first.
    if (last && last.files.length < 10) {
      const available = 10 - last.files.length;
      last.files.push(...builders.slice(0, available));
      nextAttachment = available;
    }

    // Discord accepts at most ten files per message. Emit every remaining
    // attachment across additional chunks instead of silently dropping files.
    while (nextAttachment < builders.length) {
      const files = builders.slice(nextAttachment, nextAttachment + 10);
      messages.push({
        components: [
          new TextDisplayBuilder().setContent(
            `-# 📎 ${files.length} attachment${files.length === 1 ? "" : "s"}`
          ),
        ],
        files,
      });
      nextAttachment += files.length;
    }
  }

  // proactive compaction: fold older history into the rolling summary in the
  // background once the context is half full, before the wall is ever hit
  if (shouldCompact(result.lastInputTokens)) {
    void compactConversation(conversation.id);
  }

  logger.debug("conversation turn complete", {
    userId,
    channelId,
    toolCount: toolEvents.length,
    messageChunks: messages.length,
    historyLength: history.length + 2,
  });

  return {
    messages,
    text: result.text,
    usedTools: toolEvents.length > 0,
    historyLength: history.length + 2,
  };
}
