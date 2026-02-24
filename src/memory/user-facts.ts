import { and, desc, eq, or, sql } from "drizzle-orm";
import { db, userFacts } from "../db/index.js";
import { logger } from "../logger/index.js";

export async function fetchUserFacts(params: {
  userId: string;
  guildId?: string | null;
  limit?: number;
}): Promise<string[]> {
  const limit = params.limit ?? 12;
  const guildId = params.guildId ?? null;

  logger.debug("memory: fetch user facts", {
    userId: params.userId,
    guildId,
    limit,
  });

  const guildFilter = guildId
    ? or(eq(userFacts.guildId, guildId), sql`${userFacts.guildId} is null`)
    : sql`${userFacts.guildId} is null`;

  const rows = await db
    .select({ fact: userFacts.fact })
    .from(userFacts)
    .where(
      and(
        eq(userFacts.userId, params.userId),
        eq(userFacts.active, true),
        guildFilter
      )
    )
    .orderBy(desc(userFacts.confidence), desc(userFacts.updatedAt))
    .limit(limit);

  return rows.map((row) => row.fact);
}
