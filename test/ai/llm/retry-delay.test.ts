import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { bootstrapTestEnv } from "../../helpers/setup.js";

// The SDK owns the actual sleeping, so `delayMs` is our mirror of its choice.
// Getting it wrong shows up as a status line promising the wrong wait, which no
// other test would catch — retry.test.ts pins the reporting, this pins the clock.
bootstrapTestEnv();

const { retryLoggingFetch, withRetryReporting } = await import(
  "../../../src/ai/llm/retry.js"
);
const { env } = await import("../../../src/config/env.js");
const { logger } = await import("../../../src/config/logger.js");

type Notice = { attempt: number; status?: number; delayMs: number };

const realFetch = globalThis.fetch;
const realWarn = logger.warn;

afterEach(() => {
  globalThis.fetch = realFetch;
  logger.warn = realWarn;
  env.LLM_MAX_RETRIES = 2;
});

/** Runs one wrapped call with `fetch` stubbed, returning the retry notices raised. */
async function noticesFor(
  fetchImpl: typeof globalThis.fetch,
  url = "https://api.example.invalid/v1/messages",
  calls = 1
): Promise<Notice[]> {
  const notices: Notice[] = [];
  globalThis.fetch = fetchImpl;
  logger.warn = (() => {}) as unknown as typeof logger.warn;
  await withRetryReporting(
    (notice) => notices.push(notice),
    async () => {
      for (let i = 0; i < calls; i++) {
        await retryLoggingFetch(url).catch(() => undefined);
      }
    }
  );
  return notices;
}

const failing = (headers: Record<string, string>) => async () =>
  new Response("overloaded", { status: 503, headers });

// Retry-After parsing

test("retry-after-ms is honoured exactly", async () => {
  const notices = await noticesFor(failing({ "retry-after-ms": "1500" }));
  assert.equal(notices[0]?.delayMs, 1500);
});

test("a non-numeric retry-after-ms falls through to retry-after", async () => {
  const notices = await noticesFor(
    failing({ "retry-after-ms": "soon", "retry-after": "3" })
  );
  assert.equal(notices[0]?.delayMs, 3000);
});

test("retry-after in seconds is converted to milliseconds", async () => {
  const notices = await noticesFor(failing({ "retry-after": "7" }));
  assert.equal(notices[0]?.delayMs, 7000);
});

test("an HTTP-date retry-after becomes the time until that date", async () => {
  const at = new Date(Date.now() + 5000);
  const notices = await noticesFor(
    failing({ "retry-after": at.toUTCString() })
  );
  // second-resolution date, so allow the rounding either way
  assert.ok(
    (notices[0]?.delayMs ?? 0) > 3500 && (notices[0]?.delayMs ?? 0) <= 5500,
    `unexpected delay ${notices[0]?.delayMs}`
  );
});

test("an unparseable retry-after leaves the SDK's backoff in place", async () => {
  const notices = await noticesFor(failing({ "retry-after": "whenever" }));
  assert.equal(notices[0]?.delayMs, 2000);
});

test("no retry-after at all uses the SDK's doubling backoff", async () => {
  const notices = await noticesFor(failing({}), undefined, 2);
  assert.deepEqual(
    notices.map((n) => [n.attempt, n.delayMs]),
    [
      [1, 2000],
      [2, 4000],
    ]
  );
});

test("an absurd retry-after is ignored in favour of the backoff", async () => {
  // the SDK caps what it will wait for; promising 10 minutes would be a lie
  const notices = await noticesFor(failing({ "retry-after": "600" }));
  assert.equal(notices[0]?.delayMs, 2000);
});

test("a negative retry-after is ignored", async () => {
  const notices = await noticesFor(failing({ "retry-after": "-5" }));
  assert.equal(notices[0]?.delayMs, 2000);
});

test("a long retry-after still wins once the backoff has grown past it", async () => {
  env.LLM_MAX_RETRIES = 10;
  // by attempt 7 the backoff is 128s, so a 90s Retry-After is the shorter
  // promise and is honoured despite exceeding the usual 60s ceiling
  const notices = await noticesFor(
    failing({ "retry-after": "90" }),
    undefined,
    7
  );
  assert.deepEqual(
    notices.map((n) => n.delayMs),
    [2000, 4000, 8000, 16_000, 32_000, 64_000, 90_000]
  );
});

// cycle bookkeeping

test("a successful call resets the backoff for the next failure", async () => {
  const notices: Notice[] = [];
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    // fail, fail, succeed, fail — the last failure starts a fresh cycle
    return call === 3
      ? new Response("{}", { status: 200 })
      : new Response("nope", { status: 503 });
  }) as typeof globalThis.fetch;
  logger.warn = (() => {}) as unknown as typeof logger.warn;

  await withRetryReporting(
    (notice) => notices.push(notice),
    async () => {
      for (let i = 0; i < 4; i++) {
        await retryLoggingFetch("https://api.example.invalid/v1/messages");
      }
    }
  );

  assert.deepEqual(
    notices.map((n) => [n.attempt, n.delayMs]),
    [
      [1, 2000],
      [2, 4000],
      [1, 2000],
    ]
  );
});

test("a connection failure is reported with no status and plain backoff", async () => {
  const notices = await noticesFor(async () => {
    throw new TypeError("fetch failed");
  });
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.status, undefined);
  assert.equal(notices[0]?.delayMs, 2000);
});

// url description

test("a url that isn't parseable is logged verbatim", async () => {
  const warnings: Record<string, unknown>[] = [];
  globalThis.fetch = failing({}) as typeof globalThis.fetch;
  logger.warn = ((_m: unknown, fields?: Record<string, unknown>) => {
    warnings.push(fields ?? {});
  }) as typeof logger.warn;

  await retryLoggingFetch("not-a-url");
  assert.equal(warnings[0]?.url, "not-a-url");
});

test("URL and Request inputs are described like plain strings", async () => {
  const warnings: Record<string, unknown>[] = [];
  globalThis.fetch = failing({}) as typeof globalThis.fetch;
  logger.warn = ((_m: unknown, fields?: Record<string, unknown>) => {
    warnings.push(fields ?? {});
  }) as typeof logger.warn;

  await retryLoggingFetch(new URL("https://api.example.invalid/v1/a?key=x"));
  await retryLoggingFetch(
    new Request("https://api.example.invalid/v1/b?key=x")
  );

  assert.equal(warnings[0]?.url, "https://api.example.invalid/v1/a");
  assert.equal(warnings[1]?.url, "https://api.example.invalid/v1/b");
});

// no reporting context

test("outside a reporting scope the wrapper stays silent about retries", async () => {
  globalThis.fetch = failing({}) as typeof globalThis.fetch;
  logger.warn = (() => {}) as unknown as typeof logger.warn;
  // nothing to assert but the absence of a throw: reportTransientFailure and
  // reportSettled both have to tolerate a missing async-context store
  const failed = await retryLoggingFetch("https://api.example.invalid/v1");
  assert.equal(failed.status, 503);

  globalThis.fetch = (async () =>
    new Response("{}", { status: 200 })) as typeof globalThis.fetch;
  const ok = await retryLoggingFetch("https://api.example.invalid/v1");
  assert.equal(ok.status, 200);
});
