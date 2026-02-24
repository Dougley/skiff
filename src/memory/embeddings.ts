import { type Embedding, embed } from "ai";
import { db, messageEmbeddings } from "../db/index.js";
import { embeddingProvider } from "../llm/provider.js";
import { logger } from "../logger/index.js";
import { normalizeEmbeddingDimensions } from "./vector.js";

export type EmbeddingJob = {
  messageId: number;
  conversationId: string;
  userId?: string | null;
  guildId?: string | null;
  content: string;
};

const MAX_CONTENT_CHARS = 6000;

const normalizeContent = (content: string) =>
  content.length > MAX_CONTENT_CHARS
    ? content.slice(0, MAX_CONTENT_CHARS)
    : content;

async function writeEmbedding(job: EmbeddingJob, embedding: Embedding) {
  const normalized = normalizeEmbeddingDimensions(embedding);
  await db.insert(messageEmbeddings).values({
    messageId: job.messageId,
    conversationId: job.conversationId,
    userId: job.userId ?? null,
    guildId: job.guildId ?? null,
    content: normalizeContent(job.content),
    embedding: normalized,
  });
}

export async function enqueueEmbedding(job: EmbeddingJob): Promise<boolean> {
  const model = embeddingProvider;
  if (!model) {
    logger.debug("embedding enqueue skipped: disabled", {
      messageId: job.messageId,
    });
    return false;
  }

  logger.debug("embedding enqueued", {
    messageId: job.messageId,
    conversationId: job.conversationId,
  });

  queueMicrotask(async () => {
    try {
      const result = await embed({
        model,
        value: job.content,
      });
      await writeEmbedding(job, result.embedding);
      logger.debug("embedding stored", {
        messageId: job.messageId,
      });
    } catch (err) {
      logger.warn("embedding enqueue failed", {
        messageId: job.messageId,
        err,
      });
    }
  });

  return true;
}
