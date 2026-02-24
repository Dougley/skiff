import { EMBEDDING_DIMENSIONS } from "../db/index.js";
import { logger } from "../logger/index.js";

export function normalizeEmbeddingDimensions(embedding: number[]): number[] {
  if (embedding.length === EMBEDDING_DIMENSIONS) return embedding;
  if (embedding.length > EMBEDDING_DIMENSIONS) {
    logger.warn("embedding dimension mismatch; truncating", {
      expected: EMBEDDING_DIMENSIONS,
      received: embedding.length,
    });
    return embedding.slice(0, EMBEDDING_DIMENSIONS);
  }
  logger.warn("embedding dimension mismatch; padding", {
    expected: EMBEDDING_DIMENSIONS,
    received: embedding.length,
  });
  return embedding.concat(
    Array.from({ length: EMBEDDING_DIMENSIONS - embedding.length }, () => 0)
  );
}

export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
