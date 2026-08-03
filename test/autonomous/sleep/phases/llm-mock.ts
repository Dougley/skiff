import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";

/**
 * Shared FIFO queue of canned LLM generations for the sleep-phase tests. Each
 * test file registers a vi.mock for src/ai/llm/provider.js whose
 * getLLMProvider returns a MockLanguageModelV3 that shifts from this queue —
 * an Error entry makes the call reject, a result entry resolves it.
 */
export const llmQueue: (LanguageModelV3GenerateResult | Error)[] = [];

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

/** Tokens a single successful mocked generation adds to ctx.tokenUsage. */
export const TOKENS_PER_CALL = 15;

export function jsonResult(value: unknown): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  };
}

export function queueJson(value: unknown): void {
  llmQueue.push(jsonResult(value));
}

export function queueError(message: string): void {
  llmQueue.push(new Error(message));
}

/** A 1536-dim unit vector along the given axis, for embedding columns. */
export function unitVec(axis: number): number[] {
  const v: number[] = new Array(1536).fill(0);
  v[axis] = 1;
  return v;
}

/**
 * A 1536-dim vector whose leading components are `head` and the rest zero.
 * Handy cosine pairs: vec(1) vs vec(1, 0.2) ≈ 0.98 (above every sleep
 * threshold), vec(1) vs vec(1, 1) ≈ 0.71 (below all of them), and any vector
 * against itself is exactly 1.
 */
export function vec(...head: number[]): number[] {
  const v: number[] = new Array(1536).fill(0);
  for (const [i, value] of head.entries()) v[i] = value;
  return v;
}
