import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { bootstrapTestEnv } from "../helpers/setup.js";

bootstrapTestEnv();

const originalLogLevel = process.env.LOG_LEVEL;

afterEach(() => {
  if (originalLogLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = originalLogLevel;
  }
  vi.resetModules();
});

async function loggerLevelFor(logLevel: string | undefined): Promise<number> {
  if (logLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = logLevel;
  }
  vi.resetModules();
  const { logger } = await import("../../src/config/logger.js");
  return logger.level;
}

test("defaults to info when LOG_LEVEL is unset", async () => {
  assert.equal(await loggerLevelFor(undefined), 3);
});

test("maps textual levels to consola numbers", async () => {
  assert.equal(await loggerLevelFor("fatal"), 0);
  assert.equal(await loggerLevelFor("error"), 0);
  assert.equal(await loggerLevelFor("warn"), 1);
  assert.equal(await loggerLevelFor("warning"), 1);
  assert.equal(await loggerLevelFor("INFO"), 3);
  assert.equal(await loggerLevelFor("information"), 3);
  assert.equal(await loggerLevelFor("debug"), 4);
  assert.equal(await loggerLevelFor("trace"), 5);
  assert.equal(await loggerLevelFor("silent"), -999);
  assert.equal(await loggerLevelFor("verbose"), 999);
});

test("accepts a raw numeric level", async () => {
  assert.equal(await loggerLevelFor("2"), 2);
});

test("an unrecognised LOG_LEVEL currently fails the import", async () => {
  // The `default:` arm of textualoggerLevel calls `logger.warn(...)`, but
  // `logger` is the const being initialised by that very expression, so the
  // fallback to level 3 is never reached — the module throws on the TDZ
  // access instead. Locked in so a fix has to update this expectation.
  process.env.LOG_LEVEL = "not-a-level";
  vi.resetModules();

  await assert.rejects(
    () => import("../../src/config/logger.js"),
    (error: unknown) =>
      error instanceof ReferenceError && /logger/.test(error.message)
  );
});

test("re-exports consola utils", async () => {
  const { stripAnsi } = await import("../../src/config/logger.js");
  assert.equal(stripAnsi("[31mred[0m"), "red");
});
