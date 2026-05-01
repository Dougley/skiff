import { readFile } from "node:fs/promises";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
  checklistPath: string;
  quietHoursStart: string; // "HH:MM"
  quietHoursEnd: string; // "HH:MM"
  timezone: string;
  ackMaxChars: number;
}

export function getHeartbeatConfig(): HeartbeatConfig {
  return {
    enabled: env.HEARTBEAT_ENABLED,
    intervalMs: env.HEARTBEAT_INTERVAL_MINUTES * 60 * 1000,
    checklistPath: env.HEARTBEAT_CHECKLIST_PATH,
    quietHoursStart: env.HEARTBEAT_QUIET_HOURS_START,
    quietHoursEnd: env.HEARTBEAT_QUIET_HOURS_END,
    timezone: env.HEARTBEAT_TIMEZONE,
    ackMaxChars: env.HEARTBEAT_ACK_MAX_CHARS,
  };
}

export async function loadHeartbeatChecklist(
  path: string
): Promise<string | null> {
  try {
    const content = await readFile(path, "utf-8");

    // Skip if file is empty or contains only headers/whitespace
    const stripped = content.replace(/^#+\s+.*/gm, "").trim();
    if (!stripped) {
      logger.debug("Heartbeat checklist is empty, skipping");
      return null;
    }

    return content;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      logger.debug(
        "No HEARTBEAT.md found, heartbeat will run without checklist"
      );
      return null;
    }
    logger.warn("Failed to load heartbeat checklist", { err });
    return null;
  }
}

/** Parse "HH:MM" to minutes since midnight (0-1439). */
function parseTimeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

export function isWithinActiveHours(config: HeartbeatConfig): boolean {
  const now = new Date();

  // Get current hours/minutes in the configured timezone
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);

  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  const current = hour * 60 + minute;

  const start = parseTimeToMinutes(config.quietHoursStart);
  const end = parseTimeToMinutes(config.quietHoursEnd);

  // If quiet hours don't wrap midnight (e.g., 02:00 - 06:00)
  if (start <= end) {
    return current < start || current >= end;
  }

  // If quiet hours wrap midnight (e.g., 23:00 - 08:00)
  return current >= end && current < start;
}
