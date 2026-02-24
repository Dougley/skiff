import { tool } from "ai";
import { z } from "zod";
import { aieosSchema } from "../aieos/index.js";
import { getAieos, setAieos } from "../aieos/state.js";

export enum AIEOSPartId {
  Standard = "standard",
  Metadata = "metadata",
  Capabilities = "capabilities",
  Identity = "identity",
  Physicality = "physicality",
  Psychology = "psychology",
  Linguistics = "linguistics",
  History = "history",
  Interests = "interests",
  Motivations = "motivations",
}

const aieosPartIds = Object.values(AIEOSPartId) as [
  AIEOSPartId,
  ...AIEOSPartId[],
];

export function createAIEOSTools() {
  return {
    get_aieos_part: tool({
      description:
        "Get a part of the AIEOS file by its ID. Use this when you need to access specific information or instructions defined in the AIEOS file.",
      inputSchema: z.object({
        partId: z
          .enum(aieosPartIds, {
            message: "partId must be a valid AIEOS section",
          })
          .describe("The ID of the AIEOS part to retrieve."),
      }),
      execute: async ({ partId }) => {
        const aieos = getAieos();
        if (!aieos) {
          return { error: "AIEOS is not loaded." };
        }
        const part = aieos[partId];
        if (part === undefined) {
          return { error: `No AIEOS part found with ID: ${partId}` };
        }
        return { part };
      },
    }),
    set_aieos_part: tool({
      description:
        "Set or update a part of the AIEOS file by its ID. Use this when you need to modify the AIEOS instructions or information during a conversation.",
      inputSchema: z.object({
        partId: z
          .enum(aieosPartIds, {
            message: "partId must be a valid AIEOS section",
          })
          .describe("The ID of the AIEOS part to set."),
        content: z.string().describe("The new content for the AIEOS part."),
      }),
      execute: async ({ partId, content }) => {
        const aieos = getAieos();
        if (!aieos) {
          return { error: "AIEOS is not loaded." };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          return { error: "content must be valid JSON." };
        }
        const partSchema = aieosSchema.shape[partId];
        const result = partSchema.safeParse(parsed);
        if (!result.success) {
          return { error: "content does not match the AIEOS schema." };
        }
        const updatedAieos = {
          ...aieos,
          [partId]: result.data,
        } as typeof aieos;
        setAieos(updatedAieos);
        return {
          success: true,
          updatedPart: result.data,
          hint: "These changes are not permanent and will be lost if the agent is restarted.",
        };
      },
    }),
  };
}
