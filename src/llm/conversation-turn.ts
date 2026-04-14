import type { ModelMessage } from "@ai-sdk/provider-utils";
import { container } from "@sapphire/framework";
import {
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} from "discord.js";
import {
  getLastAssistantInputTokens,
  getOrCreateConversation,
  getRecentMessages,
  insertMessage,
} from "../db/queries.js";
import { logger } from "../logger/index.js";
import { enqueueEmbedding } from "../memory/embeddings.js";
import { enqueueMemoryExtraction } from "../memory/extract.js";
import type { DiscordToolContext } from "../tools/discord.js";
import { formatSourceRef } from "../tools/sources.js";
import { EMOJI } from "../utils/emoji.js";
import {
  markdownToDiscordComponents,
  splitComponentMessages,
  type TopLevelComponent,
} from "../utils/markdown-parser.js";
import {
  formatContextUsage,
  formatToolStatusMessage,
} from "../utils/tool-status.js";
import {
  ContextWindowFullError,
  chat as chatWithLLM,
  type ToolActivityEvent,
} from "./streaming.js";
import type { MessageContext } from "./types.js";

// types

export type { MessageContext };

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
}

export interface ConversationTurnResult {
  /** The response split into message-sized chunks of components. */
  messages: TopLevelComponent[][];
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
    onToolStatus,
    skipInitialStatus,
  } = params;

  // conversation & history
  const conversation = await getOrCreateConversation({ channelId, guildId });
  const history = await getRecentMessages(conversation.id);
  const priorInputTokens = await getLastAssistantInputTokens(conversation.id);

  // persist user message
  const userMsg = await insertMessage({
    conversationId: conversation.id,
    role: "user",
    content,
    userId,
  });

  void enqueueEmbedding({
    messageId: userMsg.id,
    conversationId: conversation.id,
    userId,
    guildId,
    content,
  });

  // LLM call with debounced tool status
  const toolEvents: ToolActivityEvent[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

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
      onToolStatus(formatToolStatusMessage(toolEvents, false));
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

  let result: Awaited<ReturnType<typeof chatWithLLM>>;
  try {
    result = await chatWithLLM({
      messages: [
        ...historyToMessages(history),
        { role: "user" as const, content: `${senderMeta}\n${content}` },
      ],
      userId,
      toolContext,
      messageContext,
      onToolActivity,
      priorInputTokens,
    });
  } catch (err) {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (err instanceof ContextWindowFullError) {
      const components = markdownToDiscordComponents(
        `The conversation is too long for me to continue. Use ${clearMention(guildId)} to start a fresh conversation.`
      );
      return {
        messages: splitComponentMessages(components),
        usedTools: false,
        historyLength: history.length + 1,
      };
    }
    throw err;
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

  void enqueueEmbedding({
    messageId: assistantMsg.id,
    conversationId: conversation.id,
    userId,
    guildId,
    content: result.text,
  });

  void enqueueMemoryExtraction({
    userText: content,
    assistantText: result.text,
    userId,
    guildId,
    conversationId: conversation.id,
    sourceMessageId: assistantMsg.id,
  });

  // build response components & split into message-sized chunks
  const components = markdownToDiscordComponents(result.text);
  const messages = splitComponentMessages(components);

  // Build footer (tool summary + sources + context warning) and append to messages.
  // cite_sources is an internal tool — exclude it from the user-visible tool summary.
  // Footer components are run through splitComponentMessages to respect Discord limits,
  // then merged into the last content chunk if they fit, or sent as a trailing chunk.
  const visibleToolEvents = toolEvents.filter(
    (e) => e.type !== "tool" || e.toolName !== "cite_sources"
  );
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
    const footerComponents = [
      new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
      new TextDisplayBuilder().setContent(footerParts.join("\n")),
    ];

    const last = messages[messages.length - 1];
    if (
      last &&
      last.length + footerComponents.length <= 40 &&
      last
        .filter((c) => c instanceof TextDisplayBuilder)
        .reduce((sum, c) => sum + c.toJSON().content.length, 0) +
        footerParts.join("\n").length <=
        4000
    ) {
      // fits in the last chunk
      last.push(...footerComponents);
    } else {
      // doesn't fit — start a new trailing chunk
      messages.push(footerComponents);
    }
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
    usedTools: toolEvents.length > 0,
    historyLength: history.length + 2,
  };
}
