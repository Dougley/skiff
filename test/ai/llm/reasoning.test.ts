import assert from "node:assert/strict";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { env } = await import("../../../src/config/env.js");
const { reasoningProviderOptions, thinkingBudgetTokens } = await import(
  "../../../src/ai/llm/reasoning.js"
);

test("unset effort sends no provider options", () => {
  env.LLM_REASONING_EFFORT = undefined;
  assert.equal(reasoningProviderOptions(), undefined);
  assert.equal(thinkingBudgetTokens(), 0);
});

test("openai maps effort to reasoningEffort", () => {
  env.LLM_DEFAULT_PROVIDER = "openai";
  env.LLM_REASONING_EFFORT = "medium";
  assert.deepEqual(reasoningProviderOptions(), {
    openai: { reasoningEffort: "medium" },
  });
  assert.equal(thinkingBudgetTokens(), 0);
});

test("openai maps off to none", () => {
  env.LLM_DEFAULT_PROVIDER = "openai";
  env.LLM_REASONING_EFFORT = "off";
  assert.deepEqual(reasoningProviderOptions(), {
    openai: { reasoningEffort: "none" },
  });
});

test("ollama uses the openai namespace", () => {
  env.LLM_DEFAULT_PROVIDER = "ollama";
  env.LLM_REASONING_EFFORT = "low";
  assert.deepEqual(reasoningProviderOptions(), {
    openai: { reasoningEffort: "low" },
  });
  assert.equal(thinkingBudgetTokens(), 0);
});

test("anthropic maps effort to a thinking budget", () => {
  env.LLM_DEFAULT_PROVIDER = "anthropic";
  env.LLM_REASONING_EFFORT = "high";
  assert.deepEqual(reasoningProviderOptions(), {
    anthropic: { thinking: { type: "enabled", budgetTokens: 16384 } },
  });
  assert.equal(thinkingBudgetTokens(), 16384);
});

test("anthropic off disables thinking and reserves nothing", () => {
  env.LLM_DEFAULT_PROVIDER = "anthropic";
  env.LLM_REASONING_EFFORT = "off";
  assert.deepEqual(reasoningProviderOptions(), {
    anthropic: { thinking: { type: "disabled" } },
  });
  assert.equal(thinkingBudgetTokens(), 0);
});
