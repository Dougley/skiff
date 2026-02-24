import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { EmbeddingModel, Provider } from "ai";
import { env } from "../env/index.js";
import { logger } from "../logger/index.js";

function normalizeOllamaBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  if (/\/v1$/.test(trimmed)) {
    return trimmed;
  }
  if (/\/api$/.test(trimmed)) {
    return trimmed.replace(/\/api$/, "/v1");
  }
  return `${trimmed}/v1`;
}

export function getLLMProvider(provider?: Provider, modelOverride?: string) {
  const selectedProvider = provider || env.LLM_DEFAULT_PROVIDER;
  const selectedModel = modelOverride ?? env.LLM_DEFAULT_MODEL;
  logger.debug(
    `Initializing LLM provider: ${selectedProvider}, model: ${selectedModel}`
  );
  switch (selectedProvider) {
    case "openai": {
      if (!env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is not set");
      }
      const openai = createOpenAI({
        apiKey: env.OPENAI_API_KEY,
        baseURL: env.OPENAI_API_BASE_URL,
      });
      logger.debug(
        `OpenAI provider created${env.OPENAI_API_BASE_URL ? ` with base URL: ${env.OPENAI_API_BASE_URL}` : ""}`
      );
      return openai.chat(selectedModel);
    }
    case "anthropic": {
      if (!env.ANTHROPIC_API_KEY) {
        throw new Error("ANTHROPIC_API_KEY is not set");
      }
      const anthropic = createAnthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        baseURL: env.ANTHROPIC_API_BASE_URL,
      });
      logger.debug(
        `Anthropic provider created${env.ANTHROPIC_API_BASE_URL ? ` with base URL: ${env.ANTHROPIC_API_BASE_URL}` : ""}`
      );
      return anthropic.chat(selectedModel);
    }
    case "ollama": {
      // ollama is openai compatible, so we can use the openai provider with a custom base URL and API key
      const apiKey = env.OLLAMA_API_KEY ?? "ollama";
      if (!env.OLLAMA_API_KEY) {
        logger.debug(
          "OLLAMA_API_KEY is not set; using fallback key for Ollama"
        );
      }
      const baseURL = normalizeOllamaBaseUrl(env.OLLAMA_BASE_URL);
      if (baseURL !== env.OLLAMA_BASE_URL) {
        logger.debug("Normalized Ollama base URL", {
          baseURL: env.OLLAMA_BASE_URL,
          normalized: baseURL,
        });
      }
      const ollama = createOpenAI({
        apiKey,
        baseURL,
      });
      logger.debug(`Ollama provider created with base URL: ${baseURL}`);
      return ollama.chat(selectedModel);
    }
    default:
      throw new Error(`Unsupported LLM provider: ${selectedProvider}`);
  }
}

export function getEmbeddingProvider(): EmbeddingModel | null {
  logger.debug(
    `Initializing embedding provider: ${env.EMBEDDING_PROVIDER}, model: ${env.EMBEDDING_MODEL}`
  );
  switch (env.EMBEDDING_PROVIDER) {
    case "openai": {
      if (!env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is not set");
      }
      const openai = createOpenAI({
        apiKey: env.OPENAI_API_KEY,
        baseURL: env.OPENAI_API_BASE_URL,
      });
      logger.debug(
        `OpenAI embedding provider created${env.OPENAI_API_BASE_URL ? ` with base URL: ${env.OPENAI_API_BASE_URL}` : ""}`
      );
      return openai.embedding(env.EMBEDDING_MODEL);
    }
    case "ollama": {
      // ollama is openai compatible, so we can use the openai provider with a custom base URL and API key
      const apiKey = env.OLLAMA_API_KEY ?? "ollama";
      if (!env.OLLAMA_API_KEY) {
        logger.debug(
          "OLLAMA_API_KEY is not set; using fallback key for Ollama embeddings"
        );
      }
      const baseURL = normalizeOllamaBaseUrl(env.OLLAMA_BASE_URL);
      if (baseURL !== env.OLLAMA_BASE_URL) {
        logger.debug("Normalized Ollama base URL for embeddings", {
          baseURL: env.OLLAMA_BASE_URL,
          normalized: baseURL,
        });
      }
      const ollama = createOpenAI({
        apiKey,
        baseURL,
      });
      const model = env.EMBEDDING_MODEL;
      logger.debug(
        `Ollama embedding provider created with base URL: ${baseURL}, model: ${model}`
      );
      return ollama.embedding(model);
    }
    case "disabled":
      logger.debug("Embedding provider is disabled");
      return null;
    default:
      throw new Error(
        `Unsupported embedding provider: ${env.EMBEDDING_PROVIDER}`
      );
  }
}

export const llmProvider = getLLMProvider();
export const embeddingProvider = getEmbeddingProvider();
