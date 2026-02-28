import { tool } from "ai";
import { z } from "zod";

export interface SourceRef {
  index: number;
  url: string;
  title: string;
}

// renders a SourceRef as a footer line, e.g. "[¹](url) Title"
const SUPERSCRIPTS = "¹²³⁴⁵⁶⁷⁸⁹";
export function formatSourceRef(source: SourceRef): string {
  const sup = SUPERSCRIPTS[source.index - 1] ?? String(source.index);
  return `[${sup}](${source.url}) ${source.title}`;
}

export function createSourcesTools(collectedSources: SourceRef[]) {
  return {
    cite_sources: tool({
      description:
        "Record the sources you referenced in your response. " +
        "Call this after using web search or fetch results. " +
        "Use inline superscript characters (¹ ² ³ ⁴ ⁵...) in your text to mark each citation, " +
        "and pass the matching index (1, 2, 3...) here.",
      inputSchema: z.object({
        sources: z.array(
          z.object({
            index: z
              .number()
              .int()
              .min(1)
              .describe("The citation index (1 for ¹, 2 for ², etc.)"),
            url: z.string().url().describe("Source URL"),
            title: z
              .string()
              .describe("Short descriptive title for the source"),
          })
        ),
      }),
      execute: async ({ sources }) => {
        collectedSources.push(...sources);
        return "Sources recorded.";
      },
    }),
  };
}
