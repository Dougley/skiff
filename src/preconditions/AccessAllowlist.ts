import { Precondition } from "@sapphire/framework";
import type { ChatInputCommandInteraction } from "discord.js";
import { checkAccess, getAccessConfig } from "../access/guard.js";

export class AccessAllowlistPrecondition extends Precondition {
  public override chatInputRun(interaction: ChatInputCommandInteraction) {
    const result = checkAccess(
      {
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        isDM: !interaction.guildId,
      },
      getAccessConfig()
    );

    return result.allowed
      ? this.ok()
      : this.error({ message: result.reason ?? "Access denied" });
  }
}

declare module "@sapphire/framework" {
  interface Preconditions {
    AccessAllowlist: never;
  }
}
