import type { ApplicationCommandRegistry } from "@sapphire/framework";
import { Events, Listener } from "@sapphire/framework";
import { persistCommandIds } from "../command-id-hints.js";

/**
 * After Sapphire finishes syncing all application command registries,
 * capture the ids Discord assigned and persist them to command-ids.json
 * so future runs pass them as idHints.
 */
export class CommandIdHintsListener extends Listener<
  typeof Events.ApplicationCommandRegistriesRegistered
> {
  public constructor(
    context: Listener.LoaderContext,
    options: Listener.Options
  ) {
    super(context, {
      ...options,
      event: Events.ApplicationCommandRegistriesRegistered,
      once: true,
    });
  }

  public async run(registries: Map<string, ApplicationCommandRegistry>) {
    await persistCommandIds(registries);
  }
}
