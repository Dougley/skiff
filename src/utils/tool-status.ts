import type { ToolActivityEvent } from "../ai/llm/streaming.js";
import { env } from "../config/env.js";
import { EMOJI } from "./emoji.js";

// tool metadata

/** Human-friendly display names for known tools. */
const TOOL_LABELS: Record<string, string> = {
  web_search: "Searching the web",
  get_server_info: "Fetching server info",
  get_user_info: "Looking up user",
  get_channel_messages: "Reading channel messages",
  react_to_message: "Adding reaction",
  send_message: "Sending message",
  get_persona_part: "Reading persona",
  set_persona_part: "Adjusting persona",
  memory_search: "Searching memory",
  topic_search: "Searching topics",
  logbook_list: "Reading Logbook",
  logbook_get: "Opening storyline",
  logbook_create: "Starting storyline",
  logbook_record: "Updating Logbook",
  logbook_resolve: "Resolving open loop",
  wake_why: "Tracing the Wake",
  wake_link: "Connecting events",
  wake_add_evidence: "Attaching evidence",
  fetch_url: "Fetching web page",
  browser_cdp: "Using browser",
  read_file: "Reading file",
  write_file: "Writing file",
  shell_exec: "Running command",
  schedule_task: "Scheduling task",
  list_tasks: "Listing tasks",
  cancel_task: "Cancelling task",
  ask_questions: "Asking a question",
  list_skills: "Listing skills",
  activate_skill: "Activating skill",
  shell_job_status: "Checking command status",
};

/** Map tool names to their custom emoji. */
const TOOL_EMOJI: Record<string, string> = {
  web_search: EMOJI.internet,
  get_server_info: EMOJI.discord,
  get_user_info: EMOJI.discord,
  get_channel_messages: EMOJI.discord,
  react_to_message: EMOJI.discord,
  send_message: EMOJI.discord,
  get_persona_part: EMOJI.robot,
  set_persona_part: EMOJI.robot,
  memory_search: EMOJI.floppy,
  topic_search: EMOJI.search,
  logbook_list: EMOJI.maps,
  logbook_get: EMOJI.maps,
  logbook_create: EMOJI.maps,
  logbook_record: EMOJI.maps,
  logbook_resolve: EMOJI.maps,
  wake_why: EMOJI.maps,
  wake_link: EMOJI.maps,
  wake_add_evidence: EMOJI.maps,
  fetch_url: EMOJI.internet,
  browser_cdp: EMOJI.internet,
  read_file: EMOJI.prompt,
  write_file: EMOJI.prompt,
  shell_exec: EMOJI.prompt,
  schedule_task: EMOJI.robot,
  list_tasks: EMOJI.robot,
  cancel_task: EMOJI.robot,
  ask_questions: EMOJI.discord,
  list_skills: EMOJI.robot,
  activate_skill: EMOJI.robot,
  shell_job_status: EMOJI.prompt,
};

// loading lines

const LOADING_LINES = [
  "Thinking",
  "Pondering",
  "Mulling",
  "Cogitating",
  "Ruminating",
  "Noodling",
  "Percolating",
  "Brewing",
  "Simmering",
  "Marinating",
  "Concocting",
  "Conjuring",
  "Hatching",
  "Incubating",
  "Germinating",
  "Musing",
  "Contemplating",
  "Deliberating",
  "Cerebrating",
  "Ideating",
  "Synthesizing",
  "Coalescing",
  "Unfurling",
  "Unravelling",
  "Spelunking",
  "Meandering",
  "Puttering",
  "Tinkering",
  "Wrangling",
  "Finagling",
  "Combobulating",
  "Discombobulating",
  "Reticulating",
  "Vibing",
  "Shimmying",
  "Frolicking",
  "Moseying",
  "Perusing",
  "Sussing",
  "Wizarding",
  "Flibbertigibbeting",
  "Wibbling",
  "Booping",
].map((line) => `${line}...`);

// formatting helpers

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

function formatEventLine(event: ToolEvent): string {
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

// collapse the live tree view after this many events to keep the status compact
const COLLAPSE_THRESHOLD = 5;
// how many recent tool calls to show when collapsed
const COLLAPSE_TAIL = 2;

/**
 * Build the full intermediary status text from all tool calls so far.
 * Each event gets its own line with a tree prefix, emoji, and label.
 * Once over COLLAPSE_THRESHOLD, older events fold into a count line and
 * only the most recent COLLAPSE_TAIL calls are shown.
 */
type ToolEvent = Extract<ToolActivityEvent, { type: "tool" }>;
type TextEvent = Extract<ToolActivityEvent, { type: "text" }>;

const isToolEvent = (e: ToolActivityEvent): e is ToolEvent => e.type === "tool";
const isTextEvent = (e: ToolActivityEvent): e is TextEvent => e.type === "text";

// Cap narration so a chatty step cannot exceed Discord's TextDisplay limit.
const NARRATION_MAX_CHARS = 500;

function formatNarration(text: string): string {
  return text.length > NARRATION_MAX_CHARS
    ? `${text.slice(0, NARRATION_MAX_CHARS)}…`
    : text;
}

export function formatToolStatusMessage(
  events: ToolActivityEvent[],
  done: boolean
): string {
  // reasoning events are internal — only tool calls and interim narration are shown
  // update_status is treated specially: excluded from the tree, used as the tail line
  const toolEvents = events.filter(
    (e): e is ToolEvent => isToolEvent(e) && e.toolName !== "update_status"
  );
  const narrations = events.filter(isTextEvent);

  // latest update_status text becomes the tail instead of a random loading line
  const lastStatus = events
    .filter(isToolEvent)
    .filter((e) => e.toolName === "update_status" && isStatusOutput(e.output))
    .at(-1);
  const tailLine =
    lastStatus && isStatusOutput(lastStatus.output)
      ? `-# ╰ ${EMOJI.robot} ${lastStatus.output.status}`
      : `-# ╰ ${EMOJI.loading} ${randomLoadingLine()}`;

  if (done) {
    // collapsed single-line summary for completed turns — narration is
    // ephemeral, the final reply replaces it
    const usedWebSearch = toolEvents.some((e) => e.toolName === "web_search");
    const count = toolEvents.length;
    let summary = `-# ${EMOJI.tool} Used ${count} tool${count === 1 ? "" : "s"}`;
    if (usedWebSearch) {
      summary += `\n-# ${EMOJI.internet} Web results may be inaccurate or outdated.`;
    }
    return summary;
  }

  // A narration event contains the complete text for that model step, so keep
  // its internal newlines intact. A later tool round intentionally replaces
  // the earlier narration with its newer progress update.
  const narration = narrations.at(-1);
  const narrationLines = narration ? [formatNarration(narration.text)] : [];

  if (toolEvents.length === 0) {
    const bare =
      lastStatus && isStatusOutput(lastStatus.output)
        ? `-# ${EMOJI.robot} ${lastStatus.output.status}`
        : `-# ${EMOJI.loading} ${randomLoadingLine()}`;
    return [...narrationLines, bare].join("\n");
  }

  // show only recent tail when collapsed, folding older events into a count line
  if (toolEvents.length > COLLAPSE_THRESHOLD) {
    const tail = toolEvents.slice(-COLLAPSE_TAIL);
    const hiddenCount = toolEvents.length - COLLAPSE_TAIL;
    const lines = [
      ...narrationLines,
      `-# ╭ ··· ${hiddenCount} earlier`,
      ...tail.map((e) => `-# ├ ${formatEventLine(e)}`),
      tailLine,
    ];
    return lines.join("\n");
  }

  const lines = [
    ...narrationLines,
    ...toolEvents.map((e, i) => {
      const prefix = i === 0 ? "╭" : "├";
      return `-# ${prefix} ${formatEventLine(e)}`;
    }),
    tailLine,
  ];

  return lines.join("\n");
}

const CONTEXT_WARNING_THRESHOLD = 0.75;

/**
 * Format a context window usage warning.
 * Only returns a string when usage exceeds 75% of the context window.
 * Returns null otherwise — callers should skip rendering when null.
 */
export function formatContextUsage(inputTokens: number): string | null {
  const contextSize = env.CONTEXT_WINDOW_SIZE;
  const ratio = inputTokens / contextSize;

  if (ratio < CONTEXT_WARNING_THRESHOLD) return null;

  const pct = Math.round(ratio * 100);
  const used = inputTokens.toLocaleString();
  const max = contextSize.toLocaleString();

  if (ratio >= 0.95) {
    return `-# ${EMOJI.robot} Running out of memory: ${used} / ${max} tokens (${pct}%) - try /clear to start fresh`;
  }
  return `-# ${EMOJI.robot} Memory ${pct}% full (${used} / ${max} tokens)`;
}
