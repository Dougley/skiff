import { generateObject } from "ai";
import { z } from "zod";
import { env } from "../env/index.js";
import { getLLMProvider } from "../llm/provider.js";
import { logger } from "../logger/index.js";
import { storeExtraction } from "./store.js";

export const userFactSchema = z.object({
  fact: z.string().min(1),
  category: z.string().optional(),
  confidence: z.number().optional(),
  guildScoped: z.boolean().optional(),
});

export const topicSummarySchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string().min(1)).default([]),
});

export const memoryExtractionSchema = z.object({
  userFacts: z.array(userFactSchema).default([]),
  topicSummary: topicSummarySchema.optional(),
});

export type MemoryExtraction = z.infer<typeof memoryExtractionSchema>;

export type MemoryExtractionInput = {
  userText: string;
  assistantText: string;
  userId?: string | null;
  guildId?: string | null;
  conversationId?: string | null;
  sourceMessageId?: number | null;
};

const buildPrompt = (turns: MemoryExtractionInput[]) => {
  const turnBlocks = turns.map((t, i) => {
    return [
      `--- Turn ${i + 1} ---`,
      `User: ${t.userText.trim() || "(empty)"}`,
      `Assistant: ${t.assistantText.trim() || "(empty)"}`,
    ].join("\n");
  });

  return [
    "You extract durable memory from a conversation.",
    "Return only JSON that matches the schema.",
    "Focus on stable user facts and a concise topic summary for the whole conversation.",
    "Ignore transient details, filler, or sensitive info.",
    "",
    ...turnBlocks,
  ].join("\n");
};

export async function extractMemory(
  turns: MemoryExtractionInput[]
): Promise<MemoryExtraction> {
  const nonEmpty = turns.filter(
    (t) => t.userText?.trim() || t.assistantText?.trim()
  );
  if (nonEmpty.length === 0) {
    logger.debug("memory extraction skipped: no non-empty turns");
    return { userFacts: [] };
  }

  if (env.MEMORY_EXTRACT_MODEL === "disabled") {
    logger.debug("memory extraction disabled via env");
    return { userFacts: [] };
  }

  const modelId = env.MEMORY_EXTRACT_MODEL ?? env.LLM_DEFAULT_MODEL;
  const model = getLLMProvider(undefined, modelId);

  logger.debug("memory extraction started", {
    model: modelId,
    turnCount: nonEmpty.length,
  });

  try {
    const result = await generateObject({
      model,
      schema: memoryExtractionSchema,
      prompt: buildPrompt(nonEmpty),
      maxRetries: 1,
    });
    const normalized: MemoryExtraction = {
      userFacts: result.object.userFacts.map((fact) => ({
        ...fact,
        confidence:
          typeof fact.confidence === "number"
            ? Math.min(100, Math.max(0, fact.confidence))
            : undefined,
      })),
      topicSummary: result.object.topicSummary,
    };
    logger.debug("memory extraction completed", {
      userFacts: normalized.userFacts.length,
      hasTopicSummary: Boolean(normalized.topicSummary),
    });
    return normalized;
  } catch (err) {
    const first = nonEmpty[0];
    logger.warn("memory extraction failed", {
      userId: first?.userId ?? null,
      guildId: first?.guildId ?? null,
      conversationId: first?.conversationId ?? null,
      err,
    });
    return { userFacts: [] };
  }
}

// ---------------------------------------------------------------------------
// Conversation-idle debounce
// ---------------------------------------------------------------------------

/** How long to wait after the last message before running extraction. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

type PendingConversation = {
  turns: MemoryExtractionInput[];
  timer: ReturnType<typeof setTimeout>;
};

const pending = new Map<string, PendingConversation>();

function flushConversation(conversationId: string) {
  const entry = pending.get(conversationId);
  if (!entry || entry.turns.length === 0) {
    pending.delete(conversationId);
    return;
  }

  const turns = entry.turns;
  const last = turns[turns.length - 1];
  pending.delete(conversationId);

  logger.debug("memory extraction: conversation idle, flushing", {
    conversationId,
    turnCount: turns.length,
  });

  void extractMemory(turns)
    .then((extraction) =>
      storeExtraction({
        extraction,
        userId: last?.userId ?? null,
        guildId: last?.guildId ?? null,
        sourceMessageId: last?.sourceMessageId ?? null,
        sourceConversationId: conversationId,
      })
    )
    .catch((err) => {
      logger.warn("memory extraction flush failed", {
        conversationId,
        err,
      });
    });
}

/**
 * Buffer a turn for memory extraction. Extraction runs once the conversation
 * has been idle (no new turns) for 5 minutes.
 */
export function enqueueMemoryExtraction(input: MemoryExtractionInput): boolean {
  if (env.MEMORY_EXTRACT_MODEL === "disabled") {
    logger.debug("memory extraction enqueue skipped: disabled");
    return false;
  }
  if (!input.userText?.trim() && !input.assistantText?.trim()) {
    logger.debug("memory extraction enqueue skipped: empty turn");
    return false;
  }

  const conversationId = input.conversationId ?? "unknown";

  const existing = pending.get(conversationId);
  let bufferedTurns: number;
  if (existing) {
    clearTimeout(existing.timer);
    existing.turns.push(input);
    existing.timer = setTimeout(
      () => flushConversation(conversationId),
      IDLE_TIMEOUT_MS
    );
    bufferedTurns = existing.turns.length;
  } else {
    const timer = setTimeout(
      () => flushConversation(conversationId),
      IDLE_TIMEOUT_MS
    );
    pending.set(conversationId, { turns: [input], timer });
    bufferedTurns = 1;
  }

  logger.debug("memory extraction buffered", {
    conversationId,
    bufferedTurns,
  });

  return true;
}
