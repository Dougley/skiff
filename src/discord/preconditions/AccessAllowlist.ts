import { Precondition } from "@sapphire/framework";
import type {
  ChatInputCommandInteraction,
  ContextMenuCommandInteraction,
} from "discord.js";
import { checkAccess, getAccessConfig } from "../../config/access.js";

export class AccessAllowlistPrecondition extends Precondition {
  public override chatInputRun(interaction: ChatInputCommandInteraction) {
    return this.checkInteraction(interaction);
  }

  public override contextMenuRun(interaction: ContextMenuCommandInteraction) {
    return this.checkInteraction(interaction);
  }

  private checkInteraction(
    interaction: ChatInputCommandInteraction | ContextMenuCommandInteraction
  ) {
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
