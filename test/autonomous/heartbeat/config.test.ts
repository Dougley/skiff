import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test, vi } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv({
  HEARTBEAT_ENABLED: "false",
  HEARTBEAT_INTERVAL_MINUTES: "15",
  HEARTBEAT_CHECKLIST_PATH: "/some/checklist.md",
  HEARTBEAT_QUIET_HOURS_START: "22:00",
  HEARTBEAT_QUIET_HOURS_END: "07:30",
  HEARTBEAT_TIMEZONE: "Europe/Amsterdam",
  HEARTBEAT_ACK_MAX_CHARS: "120",
});

const { getHeartbeatConfig, isWithinActiveHours, loadHeartbeatChecklist } =
  await import("../../../src/autonomous/heartbeat/config.js");
type HeartbeatConfig = ReturnType<typeof getHeartbeatConfig>;

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/${name}`, import.meta.url));

/** Minimal config for quiet-hour checks — only the time fields matter. */
function quietHours(
  start: string,
  end: string,
  timezone = "UTC"
): HeartbeatConfig {
  return {
    enabled: true,
    intervalMs: 60_000,
    checklistPath: "unused",
    quietHoursStart: start,
    quietHoursEnd: end,
    timezone,
    ackMaxChars: 300,
  };
}

/** Evaluate isWithinActiveHours as if the wall clock read `iso`. */
function activeAt(iso: string, config: HeartbeatConfig): boolean {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
  try {
    return isWithinActiveHours(config);
  } finally {
    vi.useRealTimers();
  }
}

test("getHeartbeatConfig maps the env vars, converting minutes to ms", () => {
  assert.deepEqual(getHeartbeatConfig(), {
    enabled: false,
    intervalMs: 15 * 60 * 1000,
    checklistPath: "/some/checklist.md",
    quietHoursStart: "22:00",
    quietHoursEnd: "07:30",
    timezone: "Europe/Amsterdam",
    ackMaxChars: 120,
  });
});

test("loadHeartbeatChecklist returns the file content", async () => {
  const content = await loadHeartbeatChecklist(
    fixture("heartbeat-checklist.md")
  );
  assert.ok(content);
  assert.match(content, /Check the bilge pumps/);
});

test("a checklist with only headers and whitespace counts as empty", async () => {
  assert.equal(
    await loadHeartbeatChecklist(fixture("heartbeat-empty.md")),
    null
  );
});

test("a missing checklist file is not an error", async () => {
  assert.equal(await loadHeartbeatChecklist("/nonexistent/HEARTBEAT.md"), null);
});

test("an unreadable checklist is logged and treated as absent", async () => {
  // reading a directory fails with EISDIR, exercising the non-ENOENT branch
  assert.equal(await loadHeartbeatChecklist(fixture("")), null);
});

test("non-wrapping quiet hours block only the window between start and end", () => {
  const config = quietHours("02:00", "06:00");
  assert.equal(activeAt("2026-08-03T01:59:00Z", config), true);
  assert.equal(activeAt("2026-08-03T02:00:00Z", config), false);
  assert.equal(activeAt("2026-08-03T04:00:00Z", config), false);
  assert.equal(activeAt("2026-08-03T06:00:00Z", config), true);
  assert.equal(activeAt("2026-08-03T12:00:00Z", config), true);
});

test("quiet hours wrapping midnight block the late evening and early morning", () => {
  const config = quietHours("23:00", "08:00");
  assert.equal(activeAt("2026-08-03T22:59:00Z", config), true);
  assert.equal(activeAt("2026-08-03T23:00:00Z", config), false);
  assert.equal(activeAt("2026-08-03T03:00:00Z", config), false);
  assert.equal(activeAt("2026-08-03T07:59:00Z", config), false);
  assert.equal(activeAt("2026-08-03T08:00:00Z", config), true);
  assert.equal(activeAt("2026-08-03T12:00:00Z", config), true);
});

test("identical start and end means no quiet hours at all", () => {
  const config = quietHours("00:00", "00:00");
  assert.equal(activeAt("2026-08-03T00:00:00Z", config), true);
  assert.equal(activeAt("2026-08-03T12:00:00Z", config), true);
});

test("quiet hours are evaluated in the configured timezone", () => {
  // 23:00-08:00 quiet in New York (UTC-4 in August)
  const config = quietHours("23:00", "08:00", "America/New_York");
  // 06:00 UTC = 02:00 in New York -> quiet
  assert.equal(activeAt("2026-08-03T06:00:00Z", config), false);
  // 15:00 UTC = 11:00 in New York -> active
  assert.equal(activeAt("2026-08-03T15:00:00Z", config), true);
  // 11:30 UTC = 07:30 in New York: quiet there, but active under a UTC config
  assert.equal(activeAt("2026-08-03T11:30:00Z", config), false);
  assert.equal(
    activeAt("2026-08-03T11:30:00Z", quietHours("23:00", "08:00")),
    true
  );
});
