import assert from "node:assert/strict";
import { test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

bootstrapTestEnv();

const { getNextCronDate, isValidCron } = await import(
  "../../../src/autonomous/scheduler/cron.js"
);

test("isValidCron accepts standard 5-field expressions", () => {
  assert.equal(isValidCron("* * * * *"), true);
  assert.equal(isValidCron("*/5 * * * *"), true);
  assert.equal(isValidCron("0 12 * * 1-5"), true);
});

test("isValidCron rejects malformed expressions", () => {
  assert.equal(isValidCron("not a cron"), false);
  assert.equal(isValidCron("99 99 * * *"), false);
  assert.equal(isValidCron(""), false);
});

test("getNextCronDate evaluates in UTC by default", () => {
  const next = getNextCronDate("0 12 * * *", new Date("2026-01-01T00:00:00Z"));
  assert.deepEqual(next, new Date("2026-01-01T12:00:00Z"));
});

test("getNextCronDate is strictly after the anchor", () => {
  const next = getNextCronDate("0 12 * * *", new Date("2026-01-01T12:00:00Z"));
  assert.deepEqual(next, new Date("2026-01-02T12:00:00Z"));
});

test("getNextCronDate evaluates wall-clock time in the given timezone", () => {
  // noon in New York on 2026-01-01 is 17:00 UTC (EST, UTC-5)
  const next = getNextCronDate(
    "0 12 * * *",
    new Date("2026-01-01T00:00:00Z"),
    "America/New_York"
  );
  assert.deepEqual(next, new Date("2026-01-01T17:00:00Z"));
});

test("getNextCronDate returns null when the expression can never match", () => {
  // February 30th does not exist
  assert.equal(
    getNextCronDate("0 0 30 2 *", new Date("2026-01-01T00:00:00Z")),
    null
  );
});
