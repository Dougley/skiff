import { tool } from "ai";
import { z } from "zod";
import { personaSchema } from "../persona/index.js";
import { getPersona, setPersonaOverride } from "../persona/state.js";
import type { DiscordToolContext } from "./discord.js";

// every readable persona part
const partIds = [
  "name",
  "nickname",
  "description",
  "voice",
  "principles",
  "avoid",
  "examples",
  "meta",
] as const;

// only tone-ish parts are settable mid-turn — matches the original "tone shift"
// intent. letting the model rewrite its own examples/description is out of scope.
const settablePartIds = ["voice", "principles"] as const;

export function createPersonaTools(ctx: DiscordToolContext) {
  return {
    get_persona_part: tool({
      description:
        "Get a part of your persona by name (e.g. voice, principles, description). Use this when you need to check how you're defined.",
      inputSchema: z.object({
        partId: z
          .enum(partIds, { message: "partId must be a valid persona part" })
          .describe("The persona part to retrieve."),
      }),
      execute: async ({ partId }) => {
        const persona = getPersona(ctx.channelId);
        if (!persona) {
          return { error: "Persona is not loaded." };
        }
        const part = persona[partId];
        if (part === undefined) {
          return { error: `No persona part set for: ${partId}` };
        }
        return { part };
      },
    }),
    set_persona_part: tool({
      description:
        "Adjust your voice or principles for this channel only. Changes are in-memory and wiped on restart — this is for short-lived tone shifts, not durable growth. For lasting change, wait for the sleep cycle to write a persona addendum.",
      inputSchema: z.object({
        partId: z
          .enum(settablePartIds, {
            message: "only voice and principles can be set",
          })
          .describe("The persona part to set (voice or principles)."),
        content: z
          .string()
          .describe("The new content as a JSON array of strings."),
      }),
      execute: async ({ partId, content }) => {
        const persona = getPersona(ctx.channelId);
        if (!persona) {
          return { error: "Persona is not loaded." };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          return { error: "content must be valid JSON." };
        }
        const partSchema = personaSchema.shape[partId];
        const result = partSchema.safeParse(parsed);
        if (!result.success) {
          return { error: "content does not match the persona schema." };
        }
        setPersonaOverride(ctx.channelId, { [partId]: result.data });
        return {
          success: true,
          updatedPart: result.data,
          hint: "Applies to this channel only. Temporary, lost on restart.",
        };
      },
    }),
  };
}
