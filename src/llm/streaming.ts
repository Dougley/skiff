import type {
  AssistantModelMessage,
  ModelMessage,
  ToolModelMessage,
} from "@ai-sdk/provider-utils";
import { generateText, type LanguageModelUsage, stepCountIs } from "ai";
import { logger } from "../logger/index.js";
import { fetchUserFacts } from "../memory/user-facts.js";
import type { DiscordToolContext } from "../tools/discord.js";
import { createToolSet } from "../tools/toolset.js";
import type { MessageContext } from "./conversation-turn.js";
import { llmProvider } from "./provider.js";
import { getSystemPrompt } from "./system-prompt.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
   * Defaults to 5.
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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_STEPS = 5;

// ---------------------------------------------------------------------------
// Main chat loop
// ---------------------------------------------------------------------------

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

  const tools = await createToolSet(toolContext);
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

  let stepCounter = 0;

  logger.debug("chat: starting turn", {
    messageCount: messages.length,
    maxSteps,
    model: String(model),
  });

  const result = await generateText({
    model,
    system,
    messages,
    tools,
    stopWhen: stepCountIs(maxSteps),
    abortSignal,

    onStepFinish(stepResult) {
      const currentStep = stepCounter++;

      logger.debug("chat: step finished", {
        step: currentStep,
        finishReason: stepResult.finishReason,
        textLength: stepResult.text.length,
        toolCallCount: stepResult.toolCalls.length,
        toolResultCount: stepResult.toolResults.length,
        usage: stepResult.usage,
      });

      const reasoningTokens =
        stepResult.usage.outputTokenDetails?.reasoningTokens;
      if (reasoningTokens && reasoningTokens > 0) {
        onToolActivity?.({
          type: "reasoning",
          stepNumber: currentStep,
          tokens: reasoningTokens,
        });
      }

      for (let i = 0; i < stepResult.toolCalls.length; i++) {
        const call = stepResult.toolCalls[i];
        const toolResult = stepResult.toolResults?.[i];
        if (!call) continue;

        logger.debug("chat: tool executed", {
          step: currentStep,
          toolName: call.toolName,
          input: call.input,
          output: toolResult?.output ?? null,
        });

        onToolActivity?.({
          type: "tool",
          stepNumber: currentStep,
          toolName: call.toolName,
          args: call.input,
          output: toolResult?.output ?? null,
        });
      }
    },
  });

  logger.debug("chat: turn complete", {
    steps: result.steps.length,
    finishReason: result.finishReason,
    usage: result.usage,
  });

  return {
    text: result.text,
    responseMessages: result.response.messages as ChatResponseMessage[],
    usage: result.usage,
    finishReason: result.finishReason,
    stepCount: result.steps.length,
  };
}
