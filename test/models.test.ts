import assert from "node:assert/strict";
import test from "node:test";

process.env.DISCORD_BOT_TOKEN = `${Buffer.from("123456789012345678").toString("base64")}.test.signature`;
process.env.OPENAI_API_KEY = "test";
process.env.EMBEDDING_PROVIDER = "disabled";
process.env.DATABASE_URL = "memory://";

const { env } = await import("../src/config/env.js");
const { allowedModels, isModelAllowed, resolveModel } = await import(
  "../src/ai/llm/models.js"
);

test("empty allowlist means unrestricted", () => {
  env.LLM_ALLOWED_MODELS = "";
  env.LLM_DEFAULT_MODEL = "gpt-4o-mini";
  assert.deepEqual(allowedModels(), []);
  assert.equal(isModelAllowed("anything-at-all"), true);
  assert.equal(resolveModel("anything-at-all"), "anything-at-all");
});

test("allowlist is trimmed and de-duplicated", () => {
  env.LLM_ALLOWED_MODELS = " gpt-4o , gpt-4o-mini ,, gpt-4o ";
  assert.deepEqual(allowedModels(), ["gpt-4o", "gpt-4o-mini"]);
});

test("a non-empty allowlist rejects everything outside it", () => {
  env.LLM_ALLOWED_MODELS = "gpt-4o,gpt-4o-mini";
  assert.equal(isModelAllowed("gpt-4o"), true);
  assert.equal(isModelAllowed("o3"), false);
});

test("no override falls back to the configured default", () => {
  env.LLM_ALLOWED_MODELS = "gpt-4o";
  env.LLM_DEFAULT_MODEL = "gpt-4o-mini";
  assert.equal(resolveModel(null), "gpt-4o-mini");
  assert.equal(resolveModel(undefined), "gpt-4o-mini");
  assert.equal(resolveModel(""), "gpt-4o-mini");
});

test("an override dropped from the allowlist falls back rather than stranding a channel", () => {
  env.LLM_ALLOWED_MODELS = "gpt-4o";
  env.LLM_DEFAULT_MODEL = "gpt-4o-mini";
  assert.equal(resolveModel("gpt-4o"), "gpt-4o");
  assert.equal(resolveModel("o3"), "gpt-4o-mini");
});
