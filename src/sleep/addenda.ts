import { and, asc, eq, isNull } from "drizzle-orm";
import { db, personaAddenda } from "../db/index.js";
import { logger } from "../logger/index.js";

type AddendaCache = {
  global: string[];
  byGuild: Map<string, string[]>;
};

let cache: AddendaCache = { global: [], byGuild: new Map() };

async function fetchActive(guildId: string | null): Promise<string[]> {
  const rows = await db
    .select({ text: personaAddenda.text })
    .from(personaAddenda)
    .where(
      and(
        eq(personaAddenda.active, true),
        guildId === null
          ? isNull(personaAddenda.guildId)
          : eq(personaAddenda.guildId, guildId)
      )
    )
    .orderBy(asc(personaAddenda.createdAt));
  return rows.map((r) => r.text);
}

/**
 * Load all active addenda at startup. Reads every active row; small table,
 * in-process PGlite, one query.
 */
export async function loadAddendaCache(): Promise<void> {
  try {
    const rows = await db
      .select({
        guildId: personaAddenda.guildId,
        text: personaAddenda.text,
      })
      .from(personaAddenda)
      .where(eq(personaAddenda.active, true))
      .orderBy(asc(personaAddenda.createdAt));

    const next: AddendaCache = { global: [], byGuild: new Map() };
    for (const row of rows) {
      if (row.guildId === null) {
        next.global.push(row.text);
      } else {
        const existing = next.byGuild.get(row.guildId);
        if (existing) existing.push(row.text);
        else next.byGuild.set(row.guildId, [row.text]);
      }
    }
    cache = next;
    logger.info(
      `Persona addenda loaded: ${next.global.length} global, ${next.byGuild.size} guild-scoped`
    );
  } catch (err) {
    logger.warn("loadAddendaCache failed", { err });
    cache = { global: [], byGuild: new Map() };
  }
}

/**
 * Max addenda injected into any single system prompt, per scope. Protects
 * prompt token budget from unbounded growth as the bot grows into itself.
 * Entries are ordered oldest→newest, so we take the most recent N.
 */
const MAX_ADDENDA_PER_SCOPE = 15;

/**
 * Sync getter used by `getSystemPrompt`. Returns separate global/guild buckets
 * so callers can render them distinctly if they want. Caps each bucket to
 * keep prompt size bounded.
 */
export function getActiveAddenda(guildId?: string | null): {
  global: string[];
  guild: string[];
} {
  const guildAll = guildId ? (cache.byGuild.get(guildId) ?? []) : [];
  return {
    global: cache.global.slice(-MAX_ADDENDA_PER_SCOPE),
    guild: guildAll.slice(-MAX_ADDENDA_PER_SCOPE),
  };
}

/**
 * Invalidate and reload the cache. Call after writing new addenda or
 * reverting them. Pass a guildId to refresh just that scope; omit to refresh
 * everything.
 */
export async function refreshAddendaCache(
  guildId?: string | null
): Promise<void> {
  try {
    if (guildId === undefined) {
      await loadAddendaCache();
      return;
    }
    const rows = await fetchActive(guildId);
    if (guildId === null) {
      cache = { global: rows, byGuild: cache.byGuild };
    } else {
      if (rows.length === 0) cache.byGuild.delete(guildId);
      else cache.byGuild.set(guildId, rows);
    }
  } catch (err) {
    logger.warn("refreshAddendaCache failed", { guildId, err });
  }
}
