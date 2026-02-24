import { tool } from "ai";
import {
  ActionRowBuilder,
  ComponentType,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextDisplayBuilder,
} from "discord.js";
import { z } from "zod";
import { logger } from "../logger/index.js";
import type { DiscordToolContext } from "./discord.js";

/** How long to wait for a user to respond to a select menu (5 minutes). */
const SELECT_TIMEOUT_MS = 5 * 60 * 1000;

// TODO: re-enable when allow_other is cleaned up
// const OTHER_VALUE = "__other__";

// ---------------------------------------------------------------------------
// Tool factories
// ---------------------------------------------------------------------------

export const createUserInputTools = (ctx: DiscordToolContext) => ({
  ask_questions: tool({
    description:
      "Ask the user one or more multiple-choice questions and get their responses. " +
      "Each question is shown as a Discord select menu. Questions are presented sequentially. " +
      "Use this when you need clarification or a decision from the user before proceeding.",
    inputSchema: z.object({
      questions: z
        .array(
          z.object({
            question: z
              .string()
              .min(1)
              .max(500)
              .describe("The question to ask the user."),
            answers: z
              .array(
                z.object({
                  label: z
                    .string()
                    .min(1)
                    .max(100)
                    .describe("A short label for this answer option."),
                  value: z
                    .string()
                    .min(1)
                    .max(100)
                    .describe(
                      "The value to return if the user selects this answer."
                    ),
                })
              )
              .min(1)
              .max(24)
              .describe(
                "Predefined answer options (max 24, 25th reserved for 'Other')."
              ),
            // TODO: allow_other needs cleanup before enabling
            // allow_other: z
            //   .boolean()
            //   .default(false)
            //   .describe(
            //     "If true, adds an 'Other' option that lets the user type a custom answer."
            //   ),
          })
        )
        .min(1)
        .max(5)
        .describe("The questions to ask (max 5)."),
    }),
    execute: async ({ questions }) => {
      if (!ctx.editStatusMessage) {
        return { error: "Interactive questions are not available in this context." };
      }

      const results: Array<{ question: string; answer: string }> = [];

      for (const q of questions) {
        const answer = await askViaStatusMessage(ctx, q);
        results.push({ question: q.question, answer });
      }

      return { responses: results };
    },
  }),

  update_status: tool({
    description:
      "Send a brief status update to the user about what you're currently doing. " +
      "The message appears in the tool activity display. " +
      "Use this during long-running operations so the user knows you're still working.",
    inputSchema: z.object({
      status: z
        .string()
        .min(1)
        .max(200)
        .describe("The status message to show to the user."),
    }),
    execute: async ({ status }) => {
      // The actual display is handled by tool-status.ts which reads the
      // tool output from the ToolActivityEvent. This is intentionally a
      // passthrough — the status text flows through onStepFinish → onToolActivity
      // → formatToolStatusMessage which renders it in the tree.
      return { status };
    },
  }),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface QuestionInput {
  question: string;
  answers: Array<{ label: string; value: string }>;
  allow_other?: boolean;
}

/**
 * Show a select menu by editing the existing status message, then wait for
 * the user's selection. Does not clean up afterward — the next tool status
 * update or final response will overwrite the message naturally.
 */
async function askViaStatusMessage(
  ctx: DiscordToolContext,
  q: QuestionInput
): Promise<string> {
  const customId = `ask_q_${Date.now()}`;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder("Select an option…");

  for (const opt of q.answers) {
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(opt.label)
        .setValue(opt.value)
    );
  }

  // TODO: allow_other needs cleanup before enabling
  // if (q.allow_other) {
  //   menu.addOptions(
  //     new StringSelectMenuOptionBuilder()
  //       .setLabel("Other…")
  //       .setDescription("Type your own answer")
  //       .setValue(OTHER_VALUE)
  //   );
  // }

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    menu
  );

  // Edit the existing status message to show the select menu
  if (!ctx.editStatusMessage) return "(question UI unavailable)";

  const msg = await ctx.editStatusMessage({
    flags: MessageFlags.IsComponentsV2,
    components: [
      new TextDisplayBuilder().setContent(q.question),
      row,
    ],
  });

  if (!msg) {
    return "(failed to show question)";
  }

  try {
    const interaction = await msg.awaitMessageComponent({
      componentType: ComponentType.StringSelect,
      time: SELECT_TIMEOUT_MS,
      filter: (i) => {
        if (ctx.userId && i.user.id !== ctx.userId) return false;
        return i.customId === customId;
      },
    });

    const selected = interaction.values[0] ?? "";

    // TODO: allow_other needs cleanup before enabling
    // if (selected === OTHER_VALUE) {
    //   await interaction.update({
    //     flags: MessageFlags.IsComponentsV2,
    //     components: [
    //       new TextDisplayBuilder().setContent(`${q.question}\nPlease type your answer:`),
    //     ],
    //   });
    //   const channel = await ctx.client.channels.fetch(ctx.channelId);
    //   if (!channel || !("awaitMessages" in channel)) return "(channel unavailable)";
    //   const collected = await channel.awaitMessages({
    //     filter: (m: import("discord.js").Message) =>
    //       ctx.userId ? m.author.id === ctx.userId : true,
    //     max: 1,
    //     time: SELECT_TIMEOUT_MS,
    //   });
    //   return collected.first()?.content ?? "(no response)";
    // }

    // Acknowledge the selection (don't remove components — let it be overwritten)
    await interaction.deferUpdate();
    return selected;
  } catch (err) {
    logger.debug("Question select menu timed out or failed", { err });
    return "(no response — timed out)";
  }
}
