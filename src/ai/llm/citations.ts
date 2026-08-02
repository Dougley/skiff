/**
 * Citations travel as markdown in the model's own reply rather than through a
 * tool call.
 *
 * A tool was the obvious way to collect them and the wrong one: the model
 * naturally writes a cited answer and calls the citation tool in the same
 * response, and text written alongside a tool call is discarded by the chat
 * loop — so citing your sources was a reliable way to lose the answer. Writing
 * the list into the reply and lifting it back out here removes the tool call
 * from the answer's critical path entirely.
 */

export interface SourceRef {
  index: number;
  url: string;
  title: string;
}

const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const SUPERSCRIPT_CLASS = "[⁰¹²³⁴⁵⁶⁷⁸⁹]";

/** each digit maps to its unicode superscript so 10, 11... compose correctly */
export function toSuperscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUPERSCRIPT_DIGITS[Number(d)] ?? d)
    .join("");
}

/**
 * Reverses {@link toSuperscript}. Returns null for anything that isn't a run
 * of superscript digits denoting a positive index — `Number("¹²")` is NaN, so
 * the mapping has to be walked by hand.
 */
export function fromSuperscript(raw: string): number | null {
  if (!raw) return null;
  let digits = "";
  for (const char of raw) {
    const digit = SUPERSCRIPT_DIGITS.indexOf(char);
    if (digit === -1) return null;
    digits += String(digit);
  }
  const value = Number(digits);
  return Number.isInteger(value) && value > 0 ? value : null;
}

// renders a SourceRef as a footer line, e.g. "-# [¹](url) Title"
export function formatSourceRef(source: SourceRef): string {
  const sup = toSuperscript(source.index);
  // -# at line start renders as Discord subtext; link + title follow on the same line
  return `-# [${sup}](${source.url}) ${source.title}`;
}

// best-effort URL cleanup: models sometimes omit the scheme or emit junk.
// returns a valid http(s) URL or null if unsalvageable.
export function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/[),.;]+$/, "");
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

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const LIST_MARKER = /^[-*•]\s+/;
// our own footer shape, in case the model imitates it: [¹](url) Title
const LINK_FIRST = new RegExp(
  `^\\[(${SUPERSCRIPT_CLASS}+)\\]\\(\\s*<?([^)\\s>]+)>?\\s*\\)\\s*(.*)$`
);
// the shape we ask for: ¹ anything
const MARKER_FIRST = new RegExp(
  `^(${SUPERSCRIPT_CLASS}+)\\s*[.:)\\-–—]?\\s*(.+)$`
);
const MARKDOWN_LINK = /\[([^\]]*)\]\(\s*<?([^)\s>]+)>?\s*\)/;
const BARE_URL = /(?:https?:\/\/|www\.)\S+/i;
const SOURCES_HEADING =
  /^\s*(?:-#\s*)?(?:#{1,6}\s*)?(?:\*\*|__)?\s*sources?\s*:?\s*(?:\*\*|__)?\s*$/i;

/** Parses one trailing line into a source, or null if it isn't one. */
function parseSourceLine(raw: string): SourceRef | null {
  const line = raw.trim().replace(LIST_MARKER, "");
  if (!line) return null;

  const linkFirst = LINK_FIRST.exec(line);
  if (linkFirst) {
    const index = fromSuperscript(linkFirst[1] ?? "");
    const url = normalizeUrl(linkFirst[2] ?? "");
    if (index === null || !url) return null;
    return {
      index,
      url,
      title: (linkFirst[3] ?? "").trim() || hostnameOf(url),
    };
  }

  const markerFirst = MARKER_FIRST.exec(line);
  if (!markerFirst) return null;
  const index = fromSuperscript(markerFirst[1] ?? "");
  if (index === null) return null;
  const rest = (markerFirst[2] ?? "").trim();

  const link = MARKDOWN_LINK.exec(rest);
  if (link) {
    const url = normalizeUrl(link[2] ?? "");
    if (!url) return null;
    const label = (link[1] ?? "").trim();
    const before = rest
      .slice(0, link.index)
      .trim()
      .replace(/[-–—:]+$/, "");
    return { index, url, title: label || before.trim() || hostnameOf(url) };
  }

  const bare = BARE_URL.exec(rest);
  if (!bare) return null;
  const url = normalizeUrl(bare[0]);
  if (!url) return null;
  const before = rest
    .slice(0, bare.index)
    .trim()
    .replace(/[-–—:]+$/, "");
  return { index, url, title: before.trim() || hostnameOf(url) };
}

/**
 * Lifts a trailing citation list out of a reply.
 *
 * The scan runs backwards from the end and stops at the first line that isn't
 * a source, so superscript-marked prose in the body is never touched. Nothing
 * is stripped unless at least one source parsed, and a reply that is *only* a
 * source list is left whole — losing the visible answer to make a footer would
 * be a worse trade than a slightly raw-looking edge case.
 *
 * Indices are kept exactly as the model wrote them. Deduplication can leave
 * gaps (¹ ³), but a gap is cosmetic while renumbering would desynchronise the
 * footer from the inline markers already written into the body.
 */
export function extractSources(text: string): {
  body: string;
  sources: SourceRef[];
} {
  const lines = text.split("\n");

  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") end--;

  let start = end;
  const found: SourceRef[] = [];
  while (start > 0) {
    const parsed = parseSourceLine(lines[start - 1] ?? "");
    if (!parsed) break;
    found.unshift(parsed);
    start--;
  }
  if (found.length === 0) return { body: text, sources: [] };

  // an optional "Sources:" header sitting directly on top of the list
  if (SOURCES_HEADING.test(lines[start - 1] ?? "")) start--;

  const body = lines.slice(0, start).join("\n").trimEnd();
  if (!body.trim()) return { body: text, sources: [] };

  const sources: SourceRef[] = [];
  for (const source of found) {
    if (sources.length >= 20) break;
    if (sources.some((s) => s.url === source.url)) continue;
    sources.push({
      ...source,
      title: source.title.slice(0, 200),
    });
  }

  return { body, sources };
}
