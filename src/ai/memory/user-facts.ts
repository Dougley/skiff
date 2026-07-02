import { and, desc, eq, or, sql } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { db, userFacts } from "../../db/index.js";

/**
 * Build the scope visibility filter for a context:
 * guilds see guild facts + global facts; DMs see that channel's facts +
 * global facts. Channel facts never surface in guilds and vice versa.
 */
export function factScopeFilter(
  guildId: string | null,
  channelId?: string | null
) {
  const globalScope = sql`${userFacts.guildId} is null and ${userFacts.channelId} is null`;
  if (guildId) {
    return or(eq(userFacts.guildId, guildId), globalScope);
  }
  if (channelId) {
    return or(eq(userFacts.channelId, channelId), globalScope);
  }
  return globalScope;
}

export async function fetchUserFacts(params: {
  userId: string;
  guildId?: string | null;
  channelId?: string | null;
  limit?: number;
}): Promise<string[]> {
  const limit = params.limit ?? 12;
  const guildId = params.guildId ?? null;
  const channelId = params.channelId ?? null;

  logger.debug("memory: fetch user facts", {
    userId: params.userId,
    guildId,
    channelId,
    limit,
  });

  const rows = await db
    .select({ fact: userFacts.fact })
    .from(userFacts)
    .where(
      and(
        eq(userFacts.userId, params.userId),
        eq(userFacts.active, true),
        factScopeFilter(guildId, channelId)
      )
    )
    .orderBy(desc(userFacts.confidence), desc(userFacts.updatedAt))
    .limit(limit);

  return rows.map((row) => row.fact);
}
