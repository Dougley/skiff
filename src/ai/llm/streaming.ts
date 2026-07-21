import type { MCPClient } from "@ai-sdk/mcp";
import type {
  AssistantModelMessage,
  ModelMessage,
  ToolModelMessage,
} from "@ai-sdk/provider-utils";
import {
  APICallError,
  generateText,
  type LanguageModel,
  type LanguageModelUsage,
  stepCountIs,
  type ToolSet,
} from "ai";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { fetchUserFacts } from "../memory/user-facts.js";
import type { DiscordToolContext, TurnAttachment } from "../tools/discord.js";
import { createSourcesTools, type SourceRef } from "../tools/sources.js";
import { createToolSet } from "../tools/toolset.js";
import { llmProvider } from "./provider.js";
import { getSystemPrompt } from "./system-prompt.js";
import type { MessageContext } from "./types.js";

// prompt-caching helpers
//
// anthropic prompt caching needs explicit `cache_control` breakpoints. the
// vercel ai sdk forwards `providerOptions.anthropic.cacheControl` to the
// underlying api. openai/ollama ignore the `anthropic` namespace, so these
// helpers are safe across providers.

const ANTHROPIC_CACHE_CONTROL = {
  anthropic: { cacheControl: { type: "ephemeral" } },
} as const;

// caches the entire tools array prefix up to (and including) the last tool.
// when activate_skill injects MCP tools mid-turn, the breakpoint moves to
// whatever the new last tool is — which means the previously-cached tool
// span is invalidated for that turn. that's expected; the common path
// (no skill activation) hits the cache.
function markLastToolForCaching<T extends Record<string, unknown>>(
  tools: T
): T {
  const keys = Object.keys(tools);
  const lastKey = keys[keys.length - 1];
  if (!lastKey) return tools;
  const last = tools[lastKey] as Record<string, unknown>;
  return {
    ...tools,
    [lastKey]: {
      ...last,
      providerOptions: {
        ...((last.providerOptions as Record<string, unknown>) ?? {}),
        ...ANTHROPIC_CACHE_CONTROL,
      },
    },
  } as T;
}

// caches the conversation history up to (and including) the last message.
// turn N+1 reuses turns 1..N entirely.
function tagLastMessageForCaching(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const lastIdx = messages.length - 1;
  const last = messages[lastIdx];
  if (!last) return messages;
  const existing =
    (last as { providerOptions?: Record<string, unknown> }).providerOptions ??
    {};
  return [
    ...messages.slice(0, lastIdx),
    {
      ...last,
      providerOptions: { ...existing, ...ANTHROPIC_CACHE_CONTROL },
    } as ModelMessage,
  ];
}

// errors

// thrown when the conversation history is too long to safely call the LLM
export class ContextWindowFullError extends Error {
  constructor(
    estimatedTokens: number,
    contextWindowSize: number,
    /** Retrying is unsafe after tools have already produced side effects. */
    public readonly retrySafe = true
  ) {
    super(
      `estimated input tokens (${estimatedTokens}) near context window limit (${contextWindowSize})`
    );
    this.name = "ContextWindowFullError";
  }
}

// types

/** Fired per tool call, reasoning step, or interim narration so the caller can surface progress in Discord. */
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
    }
  | {
      type: "text";
      /** Which step in the multi-step loop (0-indexed). */
      stepNumber: number;
      /** Interim assistant text produced alongside tool calls, shown live while the turn runs. */
      text: string;
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
  /** Provider-reported input tokens from the previous turn in this conversation. */
  priorInputTokens?: number | null;
  /** Rolling summary of compacted conversation history, injected into the prompt. */
  conversationSummary?: string | null;
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
  /** Model override used by tests and specialized callers. */
  model?: LanguageModel;
  /** Tool-set override used by tests and specialized callers. */
  toolSet?: ToolSet;
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
  /** Input tokens sent in the final LLM step — the true context window pressure. */
  lastInputTokens: number;
  /** Why the model stopped generating. */
  finishReason: string;
  /** Number of LLM steps taken (1 = no tool calls, >1 = tool round-trips). */
  stepCount: number;
  /** Sources recorded via cite_sources during this turn. */
  sources: SourceRef[];
  /** Files produced by tools this turn (e.g. screenshots), to attach to the reply. */
  attachments: TurnAttachment[];
}

// constants

const DEFAULT_MAX_STEPS = 50;
const MAX_LENGTH_CONTINUATIONS = 2;

// refuse when provider-reported input tokens exceed: window - output_reserve - buffer
const MAX_CONTEXT_SAFETY_BUFFER = 20_000;

function maxOutputTokens(): number {
  // Never reserve most of a small local model's context for output. The
  // configured cap still wins for normal large-context models.
  return Math.max(
    256,
    Math.min(env.LLM_MAX_OUTPUT_TOKENS, Math.floor(env.CONTEXT_WINDOW_SIZE / 4))
  );
}

function contextOverflowThreshold(): number {
  const safetyBuffer = Math.min(
    MAX_CONTEXT_SAFETY_BUFFER,
    Math.max(1024, Math.floor(env.CONTEXT_WINDOW_SIZE * 0.1))
  );
  return Math.max(
    1,
    env.CONTEXT_WINDOW_SIZE - maxOutputTokens() - safetyBuffer
  );
}

// anthropic overflow: 400 APICallError with "prompt is too long" in the message.
// the ai sdk has no typed overflow error — https://github.com/vercel/ai/discussions/8193
function isProviderContextOverflowError(err: unknown): boolean {
  if (!APICallError.isInstance(err)) return false;
  if (err.statusCode !== 400) return false;
  return /prompt is too long|context(?:_| )length|maximum context|too many tokens/i.test(
    `${err.message} ${String(err.responseBody ?? "")}`
  );
}

function appendFinishNotice(text: string, finishReason: string): string {
  if (finishReason === "stop") return text;
  const notices: Record<string, string> = {
    "content-filter":
      "The model stopped because its safety filter interrupted the response.",
    error: "The model stopped because generation failed.",
    other: "The model stopped for an unspecified provider reason.",
  };
  const notice = notices[finishReason];
  return notice ? `${text}${text ? "\n\n" : ""}_(${notice})_` : text;
}

// main chat loop

/**
 * Run a single conversational turn against the LLM.
 *
 * This calls `generateText` with the persona system prompt, the full message
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
  const turnTimeoutSignal = AbortSignal.timeout(env.LLM_TURN_TIMEOUT_MS);
  const turnAbortSignal = abortSignal
    ? AbortSignal.any([abortSignal, turnTimeoutSignal])
    : turnTimeoutSignal;

  // shared refs: activate_skill writes tools + clients here so we can
  // inject them into the toolset and clean up processes after the turn
  const pendingSkillTools: Record<string, unknown> = {};
  const openSkillClients: MCPClient[] = [];
  const collectedSources: SourceRef[] = [];
  // fresh sink each turn so tool-produced files land on this turn's reply
  const collectedAttachments: TurnAttachment[] = [];
  toolContext.attachments = collectedAttachments;
  let tools =
    ctx.toolSet ??
    ({
      ...(await createToolSet(
        toolContext,
        pendingSkillTools,
        openSkillClients
      )),
      ...createSourcesTools(collectedSources),
    } as ToolSet);

  const model = ctx.model ?? llmProvider;
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
        channelId: toolContext.channelId,
      });
      logger.debug("user facts loaded", {
        count: userFacts.length,
      });
    } catch (err) {
      logger.warn("fetch user facts failed", { err });
    }
  }
  const { stable: systemStable, variable: systemVariable } = getSystemPrompt({
    userFacts,
    messageContext: ctx.messageContext,
    guildId: toolContext.guildId,
    channelId: toolContext.channelId,
    conversationSummary: ctx.conversationSummary,
  });

  // two system messages let us put an anthropic cache breakpoint between
  // the stable persona/tools/skills span and the per-turn variable tail.
  // openai/ollama silently concatenate them and benefit from the stable
  // prefix via automatic prefix caching (≥1024 tokens).
  const systemMessages: ModelMessage[] = [
    {
      role: "system",
      content: systemStable,
      providerOptions: { ...ANTHROPIC_CACHE_CONTROL },
    } as ModelMessage,
    { role: "system", content: systemVariable },
  ];

  logger.debug("chat: starting turn", {
    messageCount: messages.length,
    maxSteps,
    model: String(model),
  });

  // pre-flight: refuse before spending tokens if prior turn was already over threshold
  const threshold = contextOverflowThreshold();
  if (
    ctx.priorInputTokens !== undefined &&
    ctx.priorInputTokens !== null &&
    ctx.priorInputTokens > threshold
  ) {
    throw new ContextWindowFullError(
      ctx.priorInputTokens,
      env.CONTEXT_WINDOW_SIZE
    );
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
  let lastInputTokens = 0;
  let executedToolCalls = 0;

  const recordResult = (result: {
    response: { messages: unknown };
    steps: Array<{ usage: LanguageModelUsage }>;
  }): void => {
    const newMessages = result.response.messages as ChatResponseMessage[];
    allResponseMessages.push(...newMessages);
    currentMessages = [...currentMessages, ...newMessages];

    for (const step of result.steps) {
      const stepCacheRead = step.usage.inputTokenDetails?.cacheReadTokens;
      const stepCacheWrite = step.usage.inputTokenDetails?.cacheWriteTokens;
      totalUsage = {
        ...totalUsage,
        inputTokens:
          (totalUsage.inputTokens ?? 0) + (step.usage.inputTokens ?? 0),
        inputTokenDetails: {
          ...totalUsage.inputTokenDetails,
          cacheReadTokens:
            (totalUsage.inputTokenDetails?.cacheReadTokens ?? 0) +
            (stepCacheRead ?? 0),
          cacheWriteTokens:
            (totalUsage.inputTokenDetails?.cacheWriteTokens ?? 0) +
            (stepCacheWrite ?? 0),
        },
        outputTokens:
          (totalUsage.outputTokens ?? 0) + (step.usage.outputTokens ?? 0),
        totalTokens:
          (totalUsage.totalTokens ?? 0) + (step.usage.totalTokens ?? 0),
      };
      lastInputTokens = step.usage.inputTokens ?? lastInputTokens;
    }
  };

  const generateTextOnly = async (messagesForCall: ModelMessage[]) =>
    generateText({
      model,
      messages: [
        ...systemMessages,
        ...tagLastMessageForCaching(messagesForCall),
      ],
      maxOutputTokens: maxOutputTokens(),
      abortSignal: turnAbortSignal,
    }).catch((err) => {
      if (isProviderContextOverflowError(err)) {
        throw new ContextWindowFullError(
          lastInputTokens,
          env.CONTEXT_WINDOW_SIZE,
          executedToolCalls === 0
        );
      }
      throw err;
    });

  const finishTextResult = async (
    initialResult: { text: string; finishReason: string },
    responseStart: number
  ): Promise<void> => {
    finalFinishReason = initialResult.finishReason;
    if (initialResult.text) finalText = initialResult.text;

    if (initialResult.finishReason !== "length") {
      finalText = appendFinishNotice(finalText, initialResult.finishReason);
      return;
    }

    let reason: string = initialResult.finishReason;
    let continuationCount = 0;
    while (
      reason === "length" &&
      continuationCount < MAX_LENGTH_CONTINUATIONS
    ) {
      const continuationPrompt: ModelMessage = {
        role: "user",
        content:
          "Continue the response from the exact point where it stopped. Do not repeat earlier text and do not add a preamble.",
      };
      currentMessages = [...currentMessages, continuationPrompt];

      let continuation: Awaited<ReturnType<typeof generateText>>;
      try {
        continuation = await generateTextOnly(currentMessages);
      } catch (err) {
        logger.warn("chat: output continuation failed", { err });
        finalText +=
          "\n\n_(The response could not be continued after reaching the model's output limit.)_";
        reason = "continuation-error";
        finalFinishReason = "continuation-error";
        break;
      }

      recordResult(continuation);
      stepCounter++;
      finalText += continuation.text;
      reason = continuation.finishReason;
      finalFinishReason = reason;
      continuationCount++;
    }

    if (reason === "length") {
      finalText +=
        "\n\n_(The response stopped after repeatedly reaching the model's output limit.)_";
    } else {
      finalText = appendFinishNotice(finalText, reason);
    }

    // Continuation prompts are internal implementation details. Persist one
    // combined assistant message instead of several assistant fragments whose
    // hidden prompts would be missing from future history.
    allResponseMessages.splice(responseStart);
    allResponseMessages.push({
      id: crypto.randomUUID(),
      role: "assistant",
      content: finalText,
    });
  };

  try {
    while (stepCounter < maxSteps) {
      // stopWhen: stepCountIs(1) = single LLM call per iteration, tools are auto-executed
      const result = await generateText({
        model,
        messages: [
          ...systemMessages,
          ...tagLastMessageForCaching(currentMessages),
        ],
        tools: markLastToolForCaching(tools),
        stopWhen: stepCountIs(1),
        maxOutputTokens: maxOutputTokens(),
        abortSignal: turnAbortSignal,
      }).catch((err) => {
        // Providers use different messages for context overflow. Retrying the
        // whole turn is only safe before any tools have executed.
        if (isProviderContextOverflowError(err)) {
          throw new ContextWindowFullError(
            lastInputTokens,
            env.CONTEXT_WINDOW_SIZE,
            executedToolCalls === 0
          );
        }
        throw err;
      });

      const responseStart = allResponseMessages.length;
      recordResult(result);

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

        // interim narration: text the model wrote before its tool calls is
        // surfaced live in the status message. the final step's text is the
        // reply itself, so only tool-call steps emit this.
        if (result.finishReason === "tool-calls" && step.text.trim()) {
          onToolActivity?.({
            type: "text",
            stepNumber: stepCounter,
            text: step.text.trim(),
          });
        }

        for (let i = 0; i < step.toolCalls.length; i++) {
          const call = step.toolCalls[i];
          const toolResult = step.toolResults?.[i];
          if (!call) continue;
          executedToolCalls++;

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

      finalFinishReason = result.finishReason;
      stepCounter++;

      if (result.finishReason !== "tool-calls") {
        await finishTextResult(result, responseStart);
        break;
      }

      // Intermediate text is live narration, not part of the clean final
      // answer. Retain the latest fragment only as a fallback for tool-only
      // terminal steps (for example cite_sources with no follow-up text).
      if (result.text) finalText = result.text;

      // inject any MCP tools loaded by activate_skill during this step.
      // skill tools may never shadow tools that already exist (built-ins
      // or previously loaded MCP tools) — collisions are dropped.
      const pending = Object.keys(pendingSkillTools);
      if (pending.length > 0) {
        logger.debug("chat: injecting skill MCP tools", {
          tools: pending,
        });
        for (const key of pending) {
          if (key in tools) {
            logger.warn(
              "chat: skill tool collides with an existing tool — dropping",
              { tool: key }
            );
          } else {
            tools = {
              ...tools,
              [key]: pendingSkillTools[key] as ToolSet[string],
            };
          }
          delete pendingSkillTools[key];
        }
      }

      // The ordinary loop limit is a tool-call budget, not permission to omit
      // the answer. Context pressure likewise disables further tools but still
      // allows one final text-only response using the results already obtained.
      if (stepCounter >= maxSteps || lastInputTokens > threshold) {
        logger.info("chat: forcing final text response", {
          reason: stepCounter >= maxSteps ? "step-limit" : "context-pressure",
          steps: stepCounter,
          lastInputTokens,
        });
        const forcedResponseStart = allResponseMessages.length;
        const forced = await generateTextOnly(currentMessages);
        recordResult(forced);
        stepCounter++;
        await finishTextResult(forced, forcedResponseStart);
        break;
      }
    }

    // A caller-provided zero step budget should still produce a response.
    if (stepCounter === 0) {
      const responseStart = allResponseMessages.length;
      const forced = await generateTextOnly(currentMessages);
      recordResult(forced);
      stepCounter++;
      await finishTextResult(forced, responseStart);
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
    lastInputTokens,
    finishReason: finalFinishReason,
    stepCount: stepCounter,
    sources: collectedSources,
    attachments: collectedAttachments,
  };
}
