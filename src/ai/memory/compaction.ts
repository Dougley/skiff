import { generateText } from "ai";
import { and, asc, eq, gt } from "drizzle-orm";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import { conversations, db, messages } from "../../db/index.js";
import { getLLMProvider } from "../llm/provider.js";

// compact once the last turn's input exceeds this fraction of the window —
// well below the hard refusal threshold so compaction lands before the wall
const COMPACT_TRIGGER_RATIO = 0.5;

// keep the newest rows verbatim so the conversation doesn't lose its
// immediate context the moment a compaction pass runs
const KEEP_TAIL_ROWS = 4;

const MAX_ROWS_PER_PASS = 400;
const MAX_CHARS_PER_MESSAGE = 4000;

const inFlight = new Set<string>();

export function shouldCompact(
  lastInputTokens: number | null | undefined
): boolean {
  if (!lastInputTokens) return false;
  return lastInputTokens > env.CONTEXT_WINDOW_SIZE * COMPACT_TRIGGER_RATIO;
}

/**
 * Fold older messages into the conversation's rolling summary and advance the
 * summary checkpoint. Messages at or before the checkpoint are excluded from
 * the prompt history; the summary is injected into the system prompt instead.
 *
 * Returns true when a new summary was written.
 */
export async function compactConversation(
  conversationId: string
): Promise<boolean> {
  if (inFlight.has(conversationId)) return false;
  inFlight.add(conversationId);

  try {
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!conv) return false;

    const rows = await db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
      })
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          conv.summaryUpToMessageId
            ? gt(messages.id, conv.summaryUpToMessageId)
            : undefined
        )
      )
      .orderBy(asc(messages.id))
      .limit(MAX_ROWS_PER_PASS);

    if (rows.length <= KEEP_TAIL_ROWS) return false;

    const toCompact = rows.slice(0, -KEEP_TAIL_ROWS);
    const transcript = toCompact
      .filter((r) => r.content)
      .map(
        (r) => `${r.role}: ${(r.content ?? "").slice(0, MAX_CHARS_PER_MESSAGE)}`
      )
      .join("\n");
    if (!transcript) return false;

    const modelId =
      env.MEMORY_EXTRACT_MODEL && env.MEMORY_EXTRACT_MODEL !== "disabled"
        ? env.MEMORY_EXTRACT_MODEL
        : env.LLM_DEFAULT_MODEL;

    const prompt = [
      "Summarize this conversation so it can continue with your summary standing in for the full history.",
      "Preserve: who is involved, key facts and decisions, current goals, unresolved questions, and commitments made. Be specific. Drop pleasantries and tool noise.",
      "Keep it under 500 words.",
      ...(conv.summary
        ? ["", "Previous summary (fold it into the new one):", conv.summary]
        : []),
      "",
      "Conversation:",
      transcript,
    ].join("\n");

    const result = await generateText({
      model: getLLMProvider(undefined, modelId),
      prompt,
      maxRetries: 1,
    });
    const summary = result.text.trim();
    if (!summary) return false;

    const lastCompactedId = toCompact[toCompact.length - 1]?.id;
    if (lastCompactedId === undefined) return false;

    await db
      .update(conversations)
      .set({
        summary,
        summaryUpToMessageId: lastCompactedId,
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));

    logger.info("compaction: conversation summarized", {
      conversationId,
      messagesCompacted: toCompact.length,
      summaryChars: summary.length,
    });
    return true;
  } catch (err) {
    logger.warn("compaction failed", { conversationId, err });
    return false;
  } finally {
    inFlight.delete(conversationId);
  }
}
