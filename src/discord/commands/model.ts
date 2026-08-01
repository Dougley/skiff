import { Command } from "@sapphire/framework";
import {
  ApplicationIntegrationType,
  InteractionContextType,
  MessageFlags,
  type SlashCommandBuilder,
} from "discord.js";
import {
  allowedModels,
  isModelAllowed,
  MAX_MODEL_CHOICES,
  resolveModel,
} from "../../ai/llm/models.js";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";
import {
  getConversation,
  setConversationModelOverride,
} from "../../db/queries.js";
import { CommandHintKey } from "../command-id-hints.js";

/**
 * Formats the allowlist for a reply, or a note that anything goes. Discord
 * caps a message at 2000 characters, so a long list is truncated rather than
 * failing the whole reply.
 */
function describeAllowed(): string {
  const allowed = allowedModels();
  if (allowed.length === 0) {
    return "Any model your provider accepts (`LLM_ALLOWED_MODELS` is unset).";
  }
  const shown = allowed.slice(0, 40);
  const suffix =
    allowed.length > shown.length
      ? `\n…and ${allowed.length - shown.length} more`
      : "";
  return shown.map((m) => `- \`${m}\``).join("\n") + suffix;
}

export class ModelCommand extends Command {
  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, {
      ...options,
      preconditions: ["AccessAllowlist"],
      idHintKey: CommandHintKey.Model,
    });
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    // choices are baked at registration, so they reflect LLM_ALLOWED_MODELS as
    // of boot. an empty allowlist leaves the option free-text.
    const allowed = allowedModels();
    const choices = allowed.slice(0, MAX_MODEL_CHOICES);
    if (allowed.length > choices.length) {
      logger.warn(
        `LLM_ALLOWED_MODELS has ${allowed.length} entries; only the first ${MAX_MODEL_CHOICES} appear as /model choices (Discord's limit). The rest are still accepted if typed.`
      );
    }

    const buildBase = (builder: SlashCommandBuilder) =>
      builder
        .setName("model")
        .setDescription("Switch the model used in this channel")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Use a specific model in this channel")
            .addStringOption((opt) => {
              opt
                .setName("model")
                .setDescription("Model to switch to")
                .setRequired(true);
              return choices.length > 0
                ? opt.addChoices(...choices.map((m) => ({ name: m, value: m })))
                : opt;
            })
        )
        .addSubcommand((sub) =>
          sub
            .setName("show")
            .setDescription("Show the model this channel is using")
        )
        .addSubcommand((sub) =>
          sub.setName("reset").setDescription("Go back to the default model")
        );

    if (env.GUILD_ID) {
      registry.registerChatInputCommand((builder) => buildBase(builder), {
        guildIds: [env.GUILD_ID],
      });
    }

    // one global registration carrying both install types — registering the
    // same name twice with different integration types makes Sapphire PATCH
    // the command back and forth on every boot
    registry.registerChatInputCommand((builder) =>
      buildBase(builder)
        .setIntegrationTypes([
          ApplicationIntegrationType.GuildInstall,
          ApplicationIntegrationType.UserInstall,
        ])
        .setContexts([
          InteractionContextType.Guild,
          InteractionContextType.BotDM,
          InteractionContextType.PrivateChannel,
        ])
    );
  }

  public override async chatInputRun(
    interaction: Command.ChatInputCommandInteraction
  ) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand(true);
    const scope = {
      channelId: interaction.channelId,
      guildId: interaction.guildId,
    };

    switch (sub) {
      case "set": {
        const requested = interaction.options.getString("model", true).trim();
        if (!isModelAllowed(requested)) {
          await interaction.editReply(
            `\`${requested}\` isn't an allowed model. Pick one of:\n${describeAllowed()}`
          );
          return;
        }
        await setConversationModelOverride({ ...scope, model: requested });
        logger.info(
          `Model for channel ${interaction.channelId} set to ${requested} by user ${interaction.user.id}`
        );
        await interaction.editReply(
          `Now using \`${requested}\` in this channel. The conversation history carries over.`
        );
        return;
      }

      case "show": {
        const conversation = await getConversation(scope);
        const active = resolveModel(conversation?.modelOverride);
        const pinned = conversation?.modelOverride
          ? "set for this channel"
          : `the default (\`LLM_DEFAULT_MODEL\`)`;
        await interaction.editReply(
          `This channel is using \`${active}\`, ${pinned}.\n\nAvailable:\n${describeAllowed()}`
        );
        return;
      }

      case "reset": {
        await setConversationModelOverride({ ...scope, model: null });
        logger.info(
          `Model override for channel ${interaction.channelId} cleared by user ${interaction.user.id}`
        );
        await interaction.editReply(
          `Back to the default model, \`${env.LLM_DEFAULT_MODEL}\`.`
        );
        return;
      }

      default:
        await interaction.editReply("Unknown subcommand.");
    }
  }
}
