import assert from "node:assert/strict";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { cosineSimilarity, normalizeEmbeddingDimensions, toVectorLiteral } =
  await import("../../../src/ai/memory/vector.js");
const { EMBEDDING_DIMENSIONS } = await import("../../../src/db/index.js");

test("an embedding with the expected dimensions passes through untouched", () => {
  const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i);
  assert.equal(normalizeEmbeddingDimensions(embedding), embedding);
});

test("an oversized embedding is truncated to the expected dimensions", () => {
  const embedding = Array.from(
    { length: EMBEDDING_DIMENSIONS + 10 },
    (_, i) => i
  );
  const normalized = normalizeEmbeddingDimensions(embedding);
  assert.equal(normalized.length, EMBEDDING_DIMENSIONS);
  assert.deepEqual(normalized, embedding.slice(0, EMBEDDING_DIMENSIONS));
});

test("an undersized embedding is zero-padded to the expected dimensions", () => {
  const normalized = normalizeEmbeddingDimensions([1, 2, 3]);
  assert.equal(normalized.length, EMBEDDING_DIMENSIONS);
  assert.deepEqual(normalized.slice(0, 3), [1, 2, 3]);
  assert.ok(normalized.slice(3).every((value) => value === 0));
});

test("cosine similarity of a vector with itself is 1", () => {
  const similarity = cosineSimilarity([1, 2, 3], [1, 2, 3]);
  assert.ok(Math.abs(similarity - 1) < 1e-12);
});

test("cosine similarity of orthogonal vectors is 0", () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test("cosine similarity of opposite vectors is -1", () => {
  const similarity = cosineSimilarity([1, 2], [-1, -2]);
  assert.ok(Math.abs(similarity + 1) < 1e-12);
});

test("mismatched lengths, empty vectors, and zero vectors score 0", () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 2]), 0);
});

test("holes in a vector are read as zeros rather than NaN", () => {
  const sparse = new Array<number>(3);
  sparse[0] = 1;

  // 1*1 + 0*2 + 0*3 over |a||b| = 1 * sqrt(14)
  assert.ok(
    Math.abs(cosineSimilarity(sparse, [1, 2, 3]) - 1 / Math.sqrt(14)) < 1e-12
  );
  assert.ok(
    Math.abs(cosineSimilarity([1, 2, 3], sparse) - 1 / Math.sqrt(14)) < 1e-12
  );
});

test("toVectorLiteral renders the pgvector text format", () => {
  assert.equal(toVectorLiteral([1, 2.5, -3]), "[1,2.5,-3]");
  assert.equal(toVectorLiteral([]), "[]");
});
