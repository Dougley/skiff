import { EMBEDDING_DIMENSIONS } from "../../db/index.js";
import { logger } from "../../config/logger.js";

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

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
