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

// best-effort URL cleanup: models sometimes omit the scheme or emit junk.
// returns a valid http(s) URL or null if unsalvageable.
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
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
            url: z.string().min(1).describe("Source URL"),
            title: z
              .string()
              .describe("Short descriptive title for the source"),
          })
        ),
      }),
      execute: async ({ sources }) => {
        // normalize URLs and skip unsalvageable or already-recorded ones, so
        // one bad entry (or a repeated call) can't corrupt the footer
        let recorded = 0;
        for (const source of sources) {
          const url = normalizeUrl(source.url);
          if (!url) continue;
          if (collectedSources.some((s) => s.url === url)) continue;
          collectedSources.push({ ...source, url });
          recorded++;
        }
        return recorded === sources.length
          ? "Sources recorded."
          : `Recorded ${recorded} of ${sources.length} sources (invalid URLs or duplicates skipped).`;
      },
    }),
  };
}
