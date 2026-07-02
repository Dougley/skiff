import { and, asc, eq, sql } from "drizzle-orm";
import { logger } from "../../config/logger.js";
import { db, personaAddenda } from "../../db/index.js";
import { SLEEP_MAX_ADDENDA_PER_SCOPE } from "./config.js";

type AddendaCache = {
  global: string[];
  byGuild: Map<string, string[]>;
  byChannel: Map<string, string[]>;
};

let cache: AddendaCache = {
  global: [],
  byGuild: new Map(),
  byChannel: new Map(),
};

type AddendaScope =
  | { kind: "global" }
  | { kind: "guild"; guildId: string }
  | { kind: "channel"; channelId: string };

async function fetchActive(scope: AddendaScope): Promise<string[]> {
  const scopeFilter =
    scope.kind === "guild"
      ? eq(personaAddenda.guildId, scope.guildId)
      : scope.kind === "channel"
        ? eq(personaAddenda.channelId, scope.channelId)
        : sql`${personaAddenda.guildId} is null and ${personaAddenda.channelId} is null`;

  const rows = await db
    .select({ text: personaAddenda.text })
    .from(personaAddenda)
    .where(and(eq(personaAddenda.active, true), scopeFilter))
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
        channelId: personaAddenda.channelId,
        text: personaAddenda.text,
      })
      .from(personaAddenda)
      .where(eq(personaAddenda.active, true))
      .orderBy(asc(personaAddenda.createdAt));

    const next: AddendaCache = {
      global: [],
      byGuild: new Map(),
      byChannel: new Map(),
    };
    for (const row of rows) {
      if (row.guildId) {
        const existing = next.byGuild.get(row.guildId);
        if (existing) existing.push(row.text);
        else next.byGuild.set(row.guildId, [row.text]);
      } else if (row.channelId) {
        const existing = next.byChannel.get(row.channelId);
        if (existing) existing.push(row.text);
        else next.byChannel.set(row.channelId, [row.text]);
      } else {
        next.global.push(row.text);
      }
    }
    cache = next;
    logger.info(
      `Persona addenda loaded: ${next.global.length} global, ${next.byGuild.size} guild-scoped, ${next.byChannel.size} channel-scoped`
    );
  } catch (err) {
    logger.warn("loadAddendaCache failed", { err });
    cache = { global: [], byGuild: new Map(), byChannel: new Map() };
  }
}

/**
 * Max addenda injected into any single system prompt, per scope. Protects
 * prompt token budget from unbounded growth as the bot grows into itself.
 * Entries are ordered oldest→newest, so we take the most recent N.
 *
 * Guild contexts get global + guild notes; DM contexts get global + that
 * channel's notes. A guild context never sees channel notes and vice versa.
 */
export function getActiveAddenda(
  guildId?: string | null,
  channelId?: string | null
): {
  global: string[];
  guild: string[];
  channel: string[];
} {
  const guildAll = guildId ? (cache.byGuild.get(guildId) ?? []) : [];
  const channelAll =
    !guildId && channelId ? (cache.byChannel.get(channelId) ?? []) : [];
  return {
    global: cache.global.slice(-SLEEP_MAX_ADDENDA_PER_SCOPE),
    guild: guildAll.slice(-SLEEP_MAX_ADDENDA_PER_SCOPE),
    channel: channelAll.slice(-SLEEP_MAX_ADDENDA_PER_SCOPE),
  };
}

/**
 * Invalidate and reload the cache. Call after writing new addenda or
 * reverting them. Pass a guildId or channelId to refresh just that scope;
 * omit both (undefined) to refresh everything.
 */
export async function refreshAddendaCache(
  guildId?: string | null,
  channelId?: string | null
): Promise<void> {
  try {
    if (guildId === undefined && channelId === undefined) {
      await loadAddendaCache();
      return;
    }
    if (guildId) {
      const rows = await fetchActive({ kind: "guild", guildId });
      if (rows.length === 0) cache.byGuild.delete(guildId);
      else cache.byGuild.set(guildId, rows);
      return;
    }
    if (channelId) {
      const rows = await fetchActive({ kind: "channel", channelId });
      if (rows.length === 0) cache.byChannel.delete(channelId);
      else cache.byChannel.set(channelId, rows);
      return;
    }
    cache = { ...cache, global: await fetchActive({ kind: "global" }) };
  } catch (err) {
    logger.warn("refreshAddendaCache failed", { guildId, channelId, err });
  }
}
