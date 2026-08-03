import assert from "node:assert/strict";
import { beforeAll, test, vi } from "vitest";
import { bootstrapTestEnv } from "../helpers/setup.js";

bootstrapTestEnv();

const VALID_TOKEN = `${Buffer.from("123456789012345678").toString("base64")}.test.signature`;

let envModule: typeof import("../../src/config/env.js");
let logger: typeof import("../../src/config/logger.js").logger;

beforeAll(async () => {
  ({ logger } = await import("../../src/config/logger.js"));
  envModule = await import("../../src/config/env.js");
});

test("module-level env is validated from process.env at import time", () => {
  assert.equal(envModule.env.EMBEDDING_PROVIDER, "disabled");
  assert.equal(envModule.env.DATABASE_URL, "memory://");
});

test("valid input parses with defaults and coercions applied", () => {
  const parsed = envModule.validateEnvironmentVariables({
    DISCORD_BOT_TOKEN: VALID_TOKEN,
    RAG_TOP_K: "7",
    SHELL_ENABLED: "true",
  });

  assert.equal(parsed.LOG_LEVEL, "info");
  assert.equal(parsed.LLM_DEFAULT_MODEL, "gpt-4o-mini");
  assert.equal(parsed.RAG_TOP_K, 7);
  assert.equal(parsed.SHELL_ENABLED, true);
  assert.equal(parsed.VISION_ENABLED, true);
  assert.equal(parsed.CONTEXT_WINDOW_SIZE, 200_000);
});

test("missing bot token fails validation and logs the error", () => {
  const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
  try {
    assert.throws(
      () => envModule.validateEnvironmentVariables({}),
      /Invalid environment variables/
    );
    assert.equal(errorSpy.mock.calls.length, 1);
    assert.match(
      String(errorSpy.mock.calls[0]?.[0]),
      /Environment variable validation failed/
    );
  } finally {
    errorSpy.mockRestore();
  }
});

test("malformed bot tokens are rejected by the format refinement", () => {
  const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
  try {
    // wrong number of dot-separated parts
    assert.throws(() =>
      envModule.validateEnvironmentVariables({
        DISCORD_BOT_TOKEN: "only.two",
      })
    );
    // first part does not decode to a numeric id
    assert.throws(() =>
      envModule.validateEnvironmentVariables({
        DISCORD_BOT_TOKEN: `${Buffer.from("not-numeric").toString("base64")}.b.c`,
      })
    );
  } finally {
    errorSpy.mockRestore();
  }
});

test("out-of-range values are rejected", () => {
  const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
  try {
    assert.throws(() =>
      envModule.validateEnvironmentVariables({
        DISCORD_BOT_TOKEN: VALID_TOKEN,
        RAG_TOP_K: "50",
      })
    );
    assert.throws(() =>
      envModule.validateEnvironmentVariables({
        DISCORD_BOT_TOKEN: VALID_TOKEN,
        LOG_LEVEL: "bogus",
      })
    );
  } finally {
    errorSpy.mockRestore();
  }
});
