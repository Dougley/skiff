import { ApplicationCommandRegistry, container } from "@sapphire/framework";
import { logger } from "../config/logger.js";
import { commandIdHints, db } from "../db/index.js";

/**
 * Sapphire id hints, self-maintained.
 *
 * Discord treats a renamed application command as a brand new command, so
 * Sapphire asks bots to pass the previously assigned command ids as
 * `idHints` on every registration. Instead of hand-copying ids out of the
 * logs into each command file, this module:
 *
 *   1. loads known ids from the command_id_hints table at startup
 *      (before the client logs in),
 *   2. injects them into every `registerChatInputCommand` /
 *      `registerContextMenuCommand` call at the registry level, and
 *   3. writes newly assigned ids back after registration (see the
 *      ApplicationCommandRegistriesRegistered listener).
 *
 * Hints are stored under each command's `idHintKey` — a stable identity
 * declared in the command's constructor — NOT its display name. That's what
 * keeps the hint chain intact when a command is renamed: the key stays, the
 * stored ids still resolve, and Sapphire updates the existing Discord
 * command instead of creating a duplicate.
 *
 * Command ids are per bot application, so they live with the deployment's
 * database rather than the repo. A new command needs one line: an
 * `idHintKey` in its constructor (add a member to {@link CommandHintKey}).
 */

/**
 * Stable identities for id-hint storage. Add a member per command; NEVER
 * change a value once the command has been registered — the value is the
 * durable link between the code and the Discord-assigned command ids.
 * Values happen to match current command names purely for readability.
 */
export enum CommandHintKey {
  Ask = "ask",
  AskMessage = "ask-message",
  AskUser = "ask-user",
  Clear = "clear",
  Memory = "memory",
  Topic = "topic",
  Logbook = "logbook",
  Wake = "wake",
  SleepCycle = "sleep-cycle",
}

declare module "@sapphire/framework" {
  interface CommandOptions {
    /**
     * Stable identity used to store and recall Sapphire id hints. Survives
     * command renames — never change it once the command is registered.
     */
    idHintKey?: CommandHintKey;
  }
}

/** hint key → known Discord command ids (global and guild-scoped). */
const store = new Map<string, string[]>();

/**
 * Resolve a registry's stable hint key. The command store is fully
 * populated before Sapphire invokes any registerApplicationCommands, so
 * the lookup is safe at injection time.
 */
function resolveHintKey(commandName: string): string {
  // the store registry is only populated once a SapphireClient exists —
  // fall back to the name rather than ever failing a registration
  const command = container.stores?.get("commands")?.get(commandName);
  const key = command?.options.idHintKey;
  if (key) return key;
  logger.debug(
    `command "${commandName}" declares no idHintKey — falling back to its name (hints won't survive a rename)`
  );
  return commandName;
}

/** Load stored hints. Call after migrations, before the client logs in. */
export async function loadIdHintStore(): Promise<void> {
  try {
    const rows = await db.select().from(commandIdHints);
    store.clear();
    for (const row of rows) {
      store.set(row.commandName, row.ids);
    }
    if (rows.length > 0) {
      logger.debug(`Command id hints loaded for ${rows.length} commands`);
    }
  } catch (err) {
    logger.warn("Failed to load command id hints — continuing without", {
      err,
    });
  }
}

export function getIdHints(hintKey: string): string[] {
  return store.get(hintKey) ?? [];
}

type RegisterOptions = { idHints?: readonly string[] } | undefined;

function withHints<T extends RegisterOptions>(commandName: string, options: T) {
  const hints = getIdHints(resolveHintKey(commandName));
  if (hints.length === 0) return options;
  return {
    ...(options ?? {}),
    idHints: [...new Set([...(options?.idHints ?? []), ...hints])],
  };
}

/**
 * Patch the registry prototype so every registration — including commands
 * added in the future — receives id hints without any per-command wiring
 * beyond the idHintKey declaration. Explicitly provided idHints are kept
 * and merged with the stored ones.
 */
export function installIdHintInjection(): void {
  const proto = ApplicationCommandRegistry.prototype;

  const originalChatInput = proto.registerChatInputCommand;
  proto.registerChatInputCommand = function (
    ...args: Parameters<typeof originalChatInput>
  ) {
    const [command, options] = args;
    return originalChatInput.call(
      this,
      command,
      withHints(this.commandName, options)
    );
  };

  const originalContextMenu = proto.registerContextMenuCommand;
  proto.registerContextMenuCommand = function (
    ...args: Parameters<typeof originalContextMenu>
  ) {
    const [command, options] = args;
    return originalContextMenu.call(
      this,
      command,
      withHints(this.commandName, options)
    );
  };
}

/**
 * Merge the ids Discord assigned during registration into the store and
 * persist any key whose id set grew. Ids are only ever added — stale
 * hints are harmless (Sapphire ignores hints that match nothing).
 */
export async function persistCommandIds(
  registries: Map<string, ApplicationCommandRegistry>
): Promise<void> {
  // duplicate-key guard: two commands sharing a key would cross-match each
  // other's ids and let Sapphire PATCH the wrong command — refuse to store
  const byKey = new Map<string, string[]>();
  for (const name of registries.keys()) {
    const key = resolveHintKey(name);
    byKey.set(key, [...(byKey.get(key) ?? []), name]);
  }

  for (const [name, registry] of registries) {
    const key = resolveHintKey(name);
    const claimants = byKey.get(key) ?? [];
    if (claimants.length > 1) {
      logger.error(
        `idHintKey "${key}" is claimed by multiple commands (${claimants.join(", ")}) — not storing hints for it`
      );
      continue;
    }

    const ids = new Set(store.get(key) ?? []);
    const before = ids.size;
    for (const id of registry.globalChatInputCommandIds) ids.add(id);
    for (const id of registry.globalContextMenuCommandIds) ids.add(id);
    for (const set of registry.guildIdToChatInputCommandIds.values()) {
      for (const id of set) ids.add(id);
    }
    for (const set of registry.guildIdToContextMenuCommandIds.values()) {
      for (const id of set) ids.add(id);
    }
    if (ids.size === 0 || ids.size === before) continue;

    const sorted = [...ids].sort();
    store.set(key, sorted);
    try {
      await db
        .insert(commandIdHints)
        .values({ commandName: key, ids: sorted })
        .onConflictDoUpdate({
          target: commandIdHints.commandName,
          set: { ids: sorted, updatedAt: new Date() },
        });
      logger.info(`Command id hints stored for /${name}`, { key, ids: sorted });
    } catch (err) {
      logger.warn("Failed to persist command id hints", { key, err });
    }
  }
}
