import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { env } = await import("../../../src/config/env.js");
const { getEmbeddingProvider, getLLMProvider } = await import(
  "../../../src/ai/llm/provider.js"
);
const { logger } = await import("../../../src/config/logger.js");

type Model = { modelId: string; provider: string };

/** Captures logger.debug lines while `fn` runs — the base-URL handling is only observable there. */
function captureDebug<T>(fn: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const realDebug = logger.debug;
  logger.debug = ((message: unknown) => {
    lines.push(String(message));
  }) as typeof logger.debug;
  try {
    return { value: fn(), lines };
  } finally {
    logger.debug = realDebug;
  }
}

const savedEnv = {
  provider: env.LLM_DEFAULT_PROVIDER,
  model: env.LLM_DEFAULT_MODEL,
  openaiKey: env.OPENAI_API_KEY,
  openaiBase: env.OPENAI_API_BASE_URL,
  anthropicKey: env.ANTHROPIC_API_KEY,
  anthropicBase: env.ANTHROPIC_API_BASE_URL,
  ollamaKey: env.OLLAMA_API_KEY,
  ollamaBase: env.OLLAMA_BASE_URL,
  embeddingProvider: env.EMBEDDING_PROVIDER,
  embeddingModel: env.EMBEDDING_MODEL,
};

afterEach(() => {
  env.LLM_DEFAULT_PROVIDER = savedEnv.provider;
  env.LLM_DEFAULT_MODEL = savedEnv.model;
  env.OPENAI_API_KEY = savedEnv.openaiKey;
  env.OPENAI_API_BASE_URL = savedEnv.openaiBase;
  env.ANTHROPIC_API_KEY = savedEnv.anthropicKey;
  env.ANTHROPIC_API_BASE_URL = savedEnv.anthropicBase;
  env.OLLAMA_API_KEY = savedEnv.ollamaKey;
  env.OLLAMA_BASE_URL = savedEnv.ollamaBase;
  env.EMBEDDING_PROVIDER = savedEnv.embeddingProvider;
  env.EMBEDDING_MODEL = savedEnv.embeddingModel;
});

// getLLMProvider — openai

test("defaults to the configured provider and model", () => {
  const model = getLLMProvider() as Model;
  assert.equal(model.modelId, env.LLM_DEFAULT_MODEL);
  assert.match(model.provider, /openai/);
});

test("a model override wins over LLM_DEFAULT_MODEL", () => {
  const model = getLLMProvider(undefined, "gpt-4o") as Model;
  assert.equal(model.modelId, "gpt-4o");
});

test("openai without an api key refuses to construct", () => {
  env.OPENAI_API_KEY = undefined;
  assert.throws(() => getLLMProvider(), /OPENAI_API_KEY is not set/);
});

test("openai reports a custom base URL when one is configured", () => {
  env.OPENAI_API_BASE_URL = "https://proxy.example.invalid/v1";
  const { value, lines } = captureDebug(() => getLLMProvider() as Model);
  assert.equal(value.modelId, env.LLM_DEFAULT_MODEL);
  assert.ok(
    lines.some((l) =>
      l.includes("with base URL: https://proxy.example.invalid/v1")
    )
  );
});

// getLLMProvider — anthropic

test("anthropic branch constructs an anthropic model", () => {
  env.ANTHROPIC_API_KEY = "test-anthropic";
  const model = getLLMProvider(
    "anthropic" as unknown as Parameters<typeof getLLMProvider>[0],
    "claude-sonnet-4-5"
  ) as Model;
  assert.equal(model.modelId, "claude-sonnet-4-5");
  assert.match(model.provider, /anthropic/);
});

test("anthropic without an api key refuses to construct", () => {
  env.LLM_DEFAULT_PROVIDER = "anthropic";
  env.ANTHROPIC_API_KEY = undefined;
  assert.throws(() => getLLMProvider(), /ANTHROPIC_API_KEY is not set/);
});

test("anthropic reports a custom base URL when one is configured", () => {
  env.LLM_DEFAULT_PROVIDER = "anthropic";
  env.ANTHROPIC_API_KEY = "test-anthropic";
  env.ANTHROPIC_API_BASE_URL = "https://claude.example.invalid";
  const { lines } = captureDebug(() => getLLMProvider());
  assert.ok(
    lines.some((l) =>
      l.includes("with base URL: https://claude.example.invalid")
    )
  );
});

// getLLMProvider — ollama

function ollamaDebugLines(baseUrl: string, apiKey?: string): string[] {
  env.LLM_DEFAULT_PROVIDER = "ollama";
  env.OLLAMA_BASE_URL = baseUrl;
  env.OLLAMA_API_KEY = apiKey;
  return captureDebug(() => getLLMProvider(undefined, "llama3")).lines;
}

test("a bare ollama base URL gains the /v1 suffix", () => {
  const lines = ollamaDebugLines("http://localhost:11434");
  assert.ok(
    lines.some((l) =>
      l.includes(
        "Ollama provider created with base URL: http://localhost:11434/v1"
      )
    )
  );
  assert.ok(lines.some((l) => l.includes("Normalized Ollama base URL")));
});

test("trailing slashes are trimmed before normalizing", () => {
  const lines = ollamaDebugLines("http://localhost:11434///");
  assert.ok(
    lines.some((l) => l.includes("with base URL: http://localhost:11434/v1"))
  );
});

test("an /api suffix is rewritten to /v1", () => {
  const lines = ollamaDebugLines("http://localhost:11434/api");
  assert.ok(
    lines.some((l) => l.includes("with base URL: http://localhost:11434/v1"))
  );
});

test("a /v1 suffix is left alone", () => {
  const lines = ollamaDebugLines("http://localhost:11434/v1");
  assert.ok(
    lines.some((l) =>
      l.includes(
        "Ollama provider created with base URL: http://localhost:11434/v1"
      )
    )
  );
  assert.ok(!lines.some((l) => l.includes("Normalized Ollama base URL")));
});

test("a missing ollama key falls back to a placeholder key", () => {
  const lines = ollamaDebugLines("http://localhost:11434", undefined);
  assert.ok(lines.some((l) => l.includes("using fallback key for Ollama")));
});

test("a configured ollama key skips the fallback", () => {
  const lines = ollamaDebugLines("http://localhost:11434", "real-key");
  assert.ok(!lines.some((l) => l.includes("using fallback key for Ollama")));
});

test("an unsupported provider is rejected", () => {
  env.LLM_DEFAULT_PROVIDER = "bogus" as typeof env.LLM_DEFAULT_PROVIDER;
  assert.throws(() => getLLMProvider(), /Unsupported LLM provider: bogus/);
});

// getEmbeddingProvider

test("a disabled embedding provider yields null", () => {
  env.EMBEDDING_PROVIDER = "disabled";
  assert.equal(getEmbeddingProvider(), null);
});

test("the openai embedding branch uses EMBEDDING_MODEL", () => {
  env.EMBEDDING_PROVIDER = "openai";
  env.EMBEDDING_MODEL = "text-embedding-3-large";
  const model = getEmbeddingProvider() as unknown as Model;
  assert.equal(model.modelId, "text-embedding-3-large");
  assert.match(model.provider, /openai/);
});

test("openai embeddings without a key refuse to construct", () => {
  env.EMBEDDING_PROVIDER = "openai";
  env.OPENAI_API_KEY = undefined;
  assert.throws(() => getEmbeddingProvider(), /OPENAI_API_KEY is not set/);
});

test("openai embeddings report a custom base URL", () => {
  env.EMBEDDING_PROVIDER = "openai";
  env.OPENAI_API_BASE_URL = "https://proxy.example.invalid/v1";
  const { lines } = captureDebug(() => getEmbeddingProvider());
  assert.ok(
    lines.some((l) =>
      l.includes(
        "OpenAI embedding provider created with base URL: https://proxy.example.invalid/v1"
      )
    )
  );
});

test("the ollama embedding branch normalizes the base URL", () => {
  env.EMBEDDING_PROVIDER = "ollama";
  env.OLLAMA_BASE_URL = "http://localhost:11434/api";
  env.OLLAMA_API_KEY = undefined;
  env.EMBEDDING_MODEL = "nomic-embed-text";
  const { value, lines } = captureDebug(
    () => getEmbeddingProvider() as unknown as Model
  );
  assert.equal(value.modelId, "nomic-embed-text");
  assert.ok(
    lines.some((l) =>
      l.includes(
        "Ollama embedding provider created with base URL: http://localhost:11434/v1"
      )
    )
  );
  assert.ok(
    lines.some((l) => l.includes("using fallback key for Ollama embeddings"))
  );
});

test("an ollama embedding key skips the fallback and an already-normal URL stays put", () => {
  env.EMBEDDING_PROVIDER = "ollama";
  env.OLLAMA_BASE_URL = "http://localhost:11434/v1";
  env.OLLAMA_API_KEY = "real-key";
  const { lines } = captureDebug(() => getEmbeddingProvider());
  assert.ok(
    !lines.some((l) => l.includes("using fallback key for Ollama embeddings"))
  );
  assert.ok(
    !lines.some((l) => l.includes("Normalized Ollama base URL for embeddings"))
  );
});

test("an unsupported embedding provider is rejected", () => {
  env.EMBEDDING_PROVIDER = "bogus" as typeof env.EMBEDDING_PROVIDER;
  assert.throws(
    () => getEmbeddingProvider(),
    /Unsupported embedding provider: bogus/
  );
});
