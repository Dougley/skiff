import { EMOJI } from "../constants/emoji.js";
import { env } from "../env/index.js";
import type { ToolActivityEvent } from "../llm/streaming.js";

// ---------------------------------------------------------------------------
// Tool metadata
// ---------------------------------------------------------------------------

/** Human-friendly display names for known tools. */
const TOOL_LABELS: Record<string, string> = {
  web_search: "Searching the web",
  get_server_info: "Fetching server info",
  get_user_info: "Looking up user",
  get_channel_messages: "Reading channel messages",
  react_to_message: "Adding reaction",
  send_message: "Sending message",
  get_aieos_part: "Reading AIEOS config",
  set_aieos_part: "Updating AIEOS config",
  memory_search: "Searching memory",
  topic_search: "Searching topics",
  fetch_url: "Fetching web page",
  read_file: "Reading file",
  write_file: "Writing file",
  shell_exec: "Running command",
  schedule_task: "Scheduling task",
  list_tasks: "Listing tasks",
  cancel_task: "Cancelling task",
  ask_questions: "Asking a question",
};

/** Map tool names to their custom emoji. */
const TOOL_EMOJI: Record<string, string> = {
  web_search: EMOJI.internet,
  get_server_info: EMOJI.discord,
  get_user_info: EMOJI.discord,
  get_channel_messages: EMOJI.discord,
  react_to_message: EMOJI.discord,
  send_message: EMOJI.discord,
  get_aieos_part: EMOJI.robot,
  set_aieos_part: EMOJI.robot,
  memory_search: EMOJI.floppy,
  topic_search: EMOJI.search,
  fetch_url: EMOJI.internet,
  read_file: EMOJI.prompt,
  write_file: EMOJI.prompt,
  shell_exec: EMOJI.prompt,
  schedule_task: EMOJI.robot,
  list_tasks: EMOJI.robot,
  cancel_task: EMOJI.robot,
  ask_questions: EMOJI.discord,
};

// ---------------------------------------------------------------------------
// Loading lines
// ---------------------------------------------------------------------------

const LOADING_LINES = [
  "Thinking...",
  "Pondering...",
  "Mulling...",
  "Cogitating...",
  "Ruminating...",
  "Noodling...",
  "Percolating...",
  "Brewing...",
  "Simmering...",
  "Marinating...",
  "Concocting...",
  "Conjuring...",
  "Hatching...",
  "Incubating...",
  "Germinating...",
  "Musing...",
  "Contemplating...",
  "Deliberating...",
  "Cerebrating...",
  "Ideating...",
  "Synthesizing...",
  "Coalescing...",
  "Unfurling...",
  "Unravelling...",
  "Spelunking...",
  "Meandering...",
  "Puttering...",
  "Tinkering...",
  "Wrangling...",
  "Finagling...",
  "Combobulating...",
  "Discombobulating...",
  "Reticulating...",
  "Vibing...",
  "Shimmying...",
  "Frolicking...",
  "Moseying...",
  "Perusing...",
  "Sussing...",
  "Wizarding...",
  "Flibbertigibbeting...",
  "Wibbling...",
  "Booping...",
];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Build a single status line for a tool call.
 * Falls back to a generic label for unknown (e.g. MCP) tools.
 */
export function formatToolStatusLine(toolName: string): string {
  const label = TOOL_LABELS[toolName] ?? `Using ${toolName}`;
  return label;
}

function toolEmoji(toolName: string): string {
  return TOOL_EMOJI[toolName] ?? EMOJI.tool;
}

function randomLoadingLine(): string {
  return (
    LOADING_LINES[Math.floor(Math.random() * LOADING_LINES.length)] ??
    "Thinking..."
  );
}

function formatEventLine(event: ToolActivityEvent): string {
  if (event.type === "reasoning") {
    return `${EMOJI.robot} Reasoning`;
  }
  // Show custom status text for update_status tool calls
  if (event.toolName === "update_status" && isStatusOutput(event.output)) {
    return `${EMOJI.robot} ${event.output.status}`;
  }
  return `${toolEmoji(event.toolName)} ${formatToolStatusLine(event.toolName)}`;
}

function isStatusOutput(output: unknown): output is { status: string } {
  return (
    typeof output === "object" &&
    output !== null &&
    "status" in output &&
    typeof (output as { status: unknown }).status === "string"
  );
}

/**
 * Build the full intermediary status text from all tool calls so far.
 * Each event gets its own line with a tree prefix, emoji, and label.
 */
export function formatToolStatusMessage(
  events: ToolActivityEvent[],
  done: boolean
): string {
  if (events.length === 0) return `-# ${EMOJI.loading} ${randomLoadingLine()}`;

  if (done) {
    // Collapsed single-line summary for completed turns
    const toolEvents = events.filter((e) => e.type === "tool");
    const usedWebSearch = toolEvents.some((e) => e.toolName === "web_search");
    const count = toolEvents.length;
    let summary = `-# ${EMOJI.tool} Used ${count} tool${count === 1 ? "" : "s"}`;
    if (usedWebSearch) {
      summary += `\n-# ${EMOJI.internet} Web results may be inaccurate or outdated.`;
    }
    return summary;
  }

  const lines = events.map((e, i) => {
    const prefix = i === 0 ? "╭" : "├";
    return `-# ${prefix} ${formatEventLine(e)}`;
  });

  const tailPrefix = events.length === 0 ? "╶" : "╰";
  lines.push(`-# ${tailPrefix} ${EMOJI.loading} ${randomLoadingLine()}`);

  return lines.join("\n");
}

const CONTEXT_WARNING_THRESHOLD = 0.75;

/**
 * Format a context window usage warning.
 * Only returns a string when usage exceeds 75% of the context window.
 * Returns null otherwise — callers should skip rendering when null.
 */
export function formatContextUsage(
  promptTokens: number,
  completionTokens: number
): string | null {
  const totalUsed = promptTokens + completionTokens;
  const contextSize = env.CONTEXT_WINDOW_SIZE;
  const ratio = totalUsed / contextSize;

  if (ratio < CONTEXT_WARNING_THRESHOLD) return null;

  const pct = Math.round(ratio * 100);
  const used = totalUsed.toLocaleString();
  const max = contextSize.toLocaleString();

  if (ratio >= 0.95) {
    return `-# ${EMOJI.robot} Running out of memory: ${used} / ${max} tokens (${pct}%) - try /clear to start fresh`;
  }
  return `-# ${EMOJI.robot} Memory ${pct}% full (${used} / ${max} tokens)`;
}
