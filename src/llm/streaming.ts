import type { MCPClient } from "@ai-sdk/mcp";
import type {
  AssistantModelMessage,
  ModelMessage,
  ToolModelMessage,
} from "@ai-sdk/provider-utils";
import { generateText, type LanguageModelUsage, stepCountIs } from "ai";
import { env } from "../env/index.js";
import { logger } from "../logger/index.js";
import { fetchUserFacts } from "../memory/user-facts.js";
import type { DiscordToolContext } from "../tools/discord.js";
import { createSourcesTools, type SourceRef } from "../tools/sources.js";
import { createToolSet } from "../tools/toolset.js";
import { llmProvider } from "./provider.js";
import { getSystemPrompt } from "./system-prompt.js";
import type { MessageContext } from "./types.js";

// errors

// thrown when the conversation history is too long to safely call the LLM
export class ContextWindowFullError extends Error {
  constructor(estimatedTokens: number, contextWindowSize: number) {
    super(
      `estimated input tokens (${estimatedTokens}) near context window limit (${contextWindowSize})`
    );
    this.name = "ContextWindowFullError";
  }
}

// types

/** Fired once per tool call or reasoning step so the caller can surface progress in Discord. */
export type ToolActivityEvent =
  | {
      type: "tool";
      /** Which step in the multi-step loop (0-indexed). */
      stepNumber: number;
      /** Name of the tool that was called. */
      toolName: string;
      /** The arguments the model passed to the tool. */
      args: unknown;
      /** The value the tool returned (may be an error object). */
      output: unknown;
    }
  | {
      type: "reasoning";
      /** Which step in the multi-step loop (0-indexed). */
      stepNumber: number;
      /** Number of reasoning tokens used in this step. */
      tokens: number;
    };

/** Everything the chat loop needs to run a single turn. */
export interface ChatContext {
  /** Conversation history in AI SDK format. */
  messages: ModelMessage[];
  /** Discord context for building the tool set. */
  toolContext: DiscordToolContext;
  /** Optional user ID for memory injection. */
  userId?: string | null;
  /** Discord metadata about the sender and channel. */
  messageContext?: MessageContext;
  /**
   * Called after each tool execution so the caller can update a
   * "working on it…" message in Discord with live status.
   */
  onToolActivity?: (event: ToolActivityEvent) => void;
  /**
   * Maximum number of LLM ↔ tool round-trips before forcing a text reply.
   * Defaults to 50.
   */
  maxSteps?: number;
  /** Optional AbortSignal to cancel the request. */
  abortSignal?: AbortSignal;
}

/** A response message from the LLM (assistant text/tool-calls, or tool results). */
export type ChatResponseMessage = (AssistantModelMessage | ToolModelMessage) & {
  id: string;
};

/** The result of a single chat turn. */
export interface ChatResult {
  /** The final text response from the model. */
  text: string;
  /** All response messages (assistant + tool) for persisting to the DB. */
  responseMessages: ChatResponseMessage[];
  /** Token usage for the entire turn (summed across all steps). */
  usage: LanguageModelUsage;
  /** Why the model stopped generating. */
  finishReason: string;
  /** Number of LLM steps taken (1 = no tool calls, >1 = tool round-trips). */
  stepCount: number;
  /** Sources recorded via cite_sources during this turn. */
  sources: SourceRef[];
}

// constants

const DEFAULT_MAX_STEPS = 50;

// block generation when estimated input tokens exceed this fraction of the context window
const CONTEXT_BLOCK_THRESHOLD = 0.9;
// rough token overhead for system prompt + user facts (not counted in message content)
const SYSTEM_PROMPT_TOKEN_OVERHEAD = 3_000;

// helpers

// rough token estimate from message content (chars / 3.5 + system prompt overhead)
function estimateInputTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    const c = m.content;
    if (typeof c === "string") {
      chars += c.length;
    } else if (Array.isArray(c)) {
      for (const part of c) {
        if ("text" in part && typeof part.text === "string") {
          chars += part.text.length;
        } else {
          chars += JSON.stringify(part).length;
        }
      }
    }
  }
  return Math.ceil(chars / 3.5) + SYSTEM_PROMPT_TOKEN_OVERHEAD;
}

// main chat loop

/**
 * Run a single conversational turn against the LLM.
 *
 * This calls `generateText` with the AIEOS system prompt, the full message
 * history, and the Discord tool set.  Multi-step tool use is handled
 * automatically — the model can call tools up to `maxSteps` times before
 * it is forced to produce a final text reply.
 *
 * The caller receives tool-call progress via `onToolActivity` and the
 * final text + metadata via the returned `ChatResult`.
 */
export async function chat(ctx: ChatContext): Promise<ChatResult> {
  const {
    messages,
    toolContext,
    onToolActivity,
    maxSteps = DEFAULT_MAX_STEPS,
    abortSignal,
  } = ctx;

  // shared refs: activate_skill writes tools + clients here so we can
  // inject them into the toolset and clean up processes after the turn
  const pendingSkillTools: Record<string, unknown> = {};
  const openSkillClients: MCPClient[] = [];
  const collectedSources: SourceRef[] = [];
  let tools = {
    ...(await createToolSet(toolContext, pendingSkillTools, openSkillClients)),
    ...createSourcesTools(collectedSources),
  };

  const model = llmProvider;
  let userFacts: string[] = [];
  if (ctx.userId) {
    try {
      logger.debug("fetching user facts for prompt", {
        userId: ctx.userId,
        guildId: toolContext.guildId ?? null,
      });
      userFacts = await fetchUserFacts({
        userId: ctx.userId,
        guildId: toolContext.guildId,
      });
      logger.debug("user facts loaded", {
        count: userFacts.length,
      });
    } catch (err) {
      logger.warn("fetch user facts failed", { err });
    }
  }
  const system = getSystemPrompt({
    userFacts,
    messageContext: ctx.messageContext,
  });

  logger.debug("chat: starting turn", {
    messageCount: messages.length,
    maxSteps,
    model: String(model),
  });

  // pre-flight: refuse before spending tokens if history is already near the limit
  const estimated = estimateInputTokens(messages);
  if (estimated >= env.CONTEXT_WINDOW_SIZE * CONTEXT_BLOCK_THRESHOLD) {
    throw new ContextWindowFullError(estimated, env.CONTEXT_WINDOW_SIZE);
  }

  // manual agentic loop — lets us inject skill MCP tools between steps
  let currentMessages = messages;
  const allResponseMessages: ChatResponseMessage[] = [];
  let totalUsage: LanguageModelUsage = {
    inputTokens: 0,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: 0,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    totalTokens: 0,
  };
  let finalText = "";
  let finalFinishReason = "unknown";
  let stepCounter = 0;

  try {
    while (stepCounter < maxSteps) {
      // stopWhen: stepCountIs(1) = single LLM call per iteration, tools are auto-executed
      const result = await generateText({
        model,
        system,
        messages: currentMessages,
        tools,
        stopWhen: stepCountIs(1),
        abortSignal,
      });

      const newMessages = result.response.messages as ChatResponseMessage[];
      allResponseMessages.push(...newMessages);
      currentMessages = [...currentMessages, ...newMessages];

      for (const step of result.steps) {
        totalUsage = {
          ...totalUsage,
          inputTokens:
            (totalUsage.inputTokens ?? 0) + (step.usage.inputTokens ?? 0),
          outputTokens:
            (totalUsage.outputTokens ?? 0) + (step.usage.outputTokens ?? 0),
          totalTokens:
            (totalUsage.totalTokens ?? 0) + (step.usage.totalTokens ?? 0),
        };
      }

      const step = result.steps[0];
      if (step) {
        logger.debug("chat: step finished", {
          step: stepCounter,
          finishReason: step.finishReason,
          textLength: step.text.length,
          toolCallCount: step.toolCalls.length,
          toolResultCount: step.toolResults.length,
          usage: step.usage,
        });

        const reasoningTokens = step.usage.outputTokenDetails?.reasoningTokens;
        if (reasoningTokens && reasoningTokens > 0) {
          onToolActivity?.({
            type: "reasoning",
            stepNumber: stepCounter,
            tokens: reasoningTokens,
          });
        }

        for (let i = 0; i < step.toolCalls.length; i++) {
          const call = step.toolCalls[i];
          const toolResult = step.toolResults?.[i];
          if (!call) continue;

          logger.debug("chat: tool executed", {
            step: stepCounter,
            toolName: call.toolName,
            input: call.input,
            output: toolResult?.output ?? null,
          });

          onToolActivity?.({
            type: "tool",
            stepNumber: stepCounter,
            toolName: call.toolName,
            args: call.input,
            output: toolResult?.output ?? null,
          });
        }
      }

      finalText = result.text;
      finalFinishReason = result.finishReason;
      stepCounter++;

      // context overflow — the model ran out of room mid-generation
      if (result.finishReason === "length") {
        throw new ContextWindowFullError(
          totalUsage.inputTokens ?? 0,
          env.CONTEXT_WINDOW_SIZE
        );
      }

      if (result.finishReason !== "tool-calls") break; // model is done (text, error, etc.)

      // inject any MCP tools loaded by activate_skill during this step
      const pending = Object.keys(pendingSkillTools);
      if (pending.length > 0) {
        logger.debug("chat: injecting skill MCP tools", {
          tools: pending,
        });
        tools = { ...tools, ...pendingSkillTools };
        for (const key of pending) {
          delete pendingSkillTools[key];
        }
      }
    }
  } finally {
    // close any skill MCP servers that were started during this turn
    await Promise.allSettled(
      openSkillClients.map(async (c) => {
        logger.debug("chat: closing skill MCP client", {
          client: String(c),
        });
        return c.close().catch((err) => {
          logger.warn("Failed to close skill MCP client", {
            client: String(c),
            err,
          });
        });
      })
    );
  }

  logger.debug("chat: turn complete", {
    steps: stepCounter,
    finishReason: finalFinishReason,
    usage: totalUsage,
  });

  return {
    text: finalText,
    responseMessages: allResponseMessages,
    usage: totalUsage,
    finishReason: finalFinishReason,
    stepCount: stepCounter,
    sources: collectedSources,
  };
}
