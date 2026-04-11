import { tool } from "ai";
import { z } from "zod";

export interface SourceRef {
  index: number;
  url: string;
  title: string;
}

// renders a SourceRef as a footer line, e.g. "-# [¹](url) Title"
// each digit maps to its unicode superscript so compound numbers (10, 11...) compose correctly
const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
function toSuperscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUPERSCRIPT_DIGITS[Number(d)] ?? d)
    .join("");
}

export function formatSourceRef(source: SourceRef): string {
  const sup = toSuperscript(source.index);
  // -# at line start renders as Discord subtext; link + title follow on the same line
  return `-# [${sup}](${source.url}) ${source.title}`;
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
            url: z.url().describe("Source URL"),
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
