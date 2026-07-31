import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { env } from "../../config/env.js";

/**
 * Maps the provider-neutral LLM_REASONING_EFFORT setting onto each provider's
 * native knob:
 *
 * - openai / ollama: `reasoning_effort` on the chat completions request.
 *   Ollama's OpenAI-compatible endpoint forwards it to models that support
 *   think levels; models that don't simply ignore it.
 * - anthropic: extended thinking with a token budget per effort level.
 *
 * When the variable is unset, no options are sent and the provider default
 * applies. This only covers the interactive chat loop — background jobs
 * (memory extraction, sleep phases) intentionally keep provider defaults.
 */

type ReasoningEffort = NonNullable<typeof env.LLM_REASONING_EFFORT>;

// Anthropic counts thinking toward max_tokens, so these budgets are added on
// top of the normal output reserve (see maxOutputTokens in streaming.ts).
// 1024 is the API's minimum accepted budget.
const ANTHROPIC_THINKING_BUDGETS: Record<
  Exclude<ReasoningEffort, "off">,
  number
> = {
  minimal: 1024,
  low: 4096,
  medium: 8192,
  high: 16384,
};

/**
 * Extra output tokens to request so Anthropic thinking doesn't eat into the
 * visible-response budget. Zero for other providers or when effort is unset.
 */
export function thinkingBudgetTokens(): number {
  const effort = env.LLM_REASONING_EFFORT;
  if (!effort || effort === "off" || env.LLM_DEFAULT_PROVIDER !== "anthropic") {
    return 0;
  }
  return ANTHROPIC_THINKING_BUDGETS[effort];
}

/**
 * Request-level providerOptions for generateText, or undefined when the
 * provider default should apply.
 */
export function reasoningProviderOptions(): ProviderOptions | undefined {
  const effort = env.LLM_REASONING_EFFORT;
  if (!effort) return undefined;

  switch (env.LLM_DEFAULT_PROVIDER) {
    case "anthropic":
      return {
        anthropic: {
          thinking:
            effort === "off"
              ? { type: "disabled" }
              : {
                  type: "enabled",
                  budgetTokens: ANTHROPIC_THINKING_BUDGETS[effort],
                },
        },
      };
    // ollama runs through the openai-compatible provider, so both read the
    // `openai` key
    case "openai":
    case "ollama":
      return {
        openai: { reasoningEffort: effort === "off" ? "none" : effort },
      };
    default:
      return undefined;
  }
}
