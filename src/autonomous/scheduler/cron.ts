/**
 * Cron expression utilities — thin wrapper around croner.
 *
 * Supports 5-field standard cron with IANA timezone via Intl.DateTimeFormat.
 * See https://github.com/Hexagon/croner for full syntax support
 * (L, W, #, 6/7 fields, etc.).
 */

import { Cron } from "croner";

/**
 * Check if a cron expression is syntactically valid.
 */
export function isValidCron(expression: string): boolean {
  try {
    new Cron(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the next Date (UTC) matching a cron expression, starting strictly after `after`.
 * Cron fields are evaluated against wall-clock time in the given `timezone` (IANA, e.g.
 * "America/New_York"). Defaults to UTC. DST transitions are handled by croner via
 * Intl.DateTimeFormat.
 *
 * Returns null if no match is found.
 */
export function getNextCronDate(
  expression: string,
  after: Date,
  timezone = "UTC"
): Date | null {
  const job = new Cron(expression, { timezone });
  return job.nextRun(after) ?? null;
}
