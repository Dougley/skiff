import { AsyncLocalStorage } from "node:async_hooks";
import { type FetchFunction, isAbortError } from "@ai-sdk/provider-utils";
import { env } from "../../config/env.js";
import { logger } from "../../config/logger.js";

/**
 * How many times to re-issue a failed provider request.
 *
 * The AI SDK retries with exponential backoff, honouring `Retry-After`. It
 * retries only what's worth retrying: HTTP 408/409/429/5xx and connection
 * failures (which the provider layer wraps into a retryable `APICallError`).
 * A 4xx from a bad request, and an abort or timeout, fail immediately.
 *
 * Retries wrap the model call itself, not the surrounding step, so a retried
 * turn never re-executes tools that already ran.
 *
 * Every provider call passes this explicitly rather than leaning on the SDK's
 * own default, so the policy is one value here instead of an implicit setting
 * that a dependency bump could change underneath us.
 */
export function llmMaxRetries(): number {
  return env.LLM_MAX_RETRIES;
}

/** A transient failure that another attempt is going to follow. */
export type RetryNotice = {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  /** HTTP status when the provider answered at all; absent for connection failures. */
  status?: number;
  /** How long until the next attempt starts. */
  delayMs: number;
};

type ReportingContext = {
  notify: (notice: RetryNotice) => void;
  /** Consecutive transient failures in the current retry cycle. */
  failures: number;
};

// carries the reporter from the turn down to the transport layer. the retry
// itself lives inside the SDK, so there's no callback to hang this on and no
// argument to thread — but the async context reaches it untouched.
const reporting = new AsyncLocalStorage<ReportingContext>();

/**
 * Runs `fn` with retries reported to `notify`, so a turn can tell the user
 * it's waiting on the provider rather than appearing to hang.
 */
export function withRetryReporting<T>(
  notify: (notice: RetryNotice) => void,
  fn: () => Promise<T>
): Promise<T> {
  return reporting.run({ notify, failures: 0 }, fn);
}

// The SDK fixes its backoff at 2s doubling per attempt and exposes no way to
// configure it (`generateText` forwards maxRetries and nothing else), so
// predicting when the next attempt lands means mirroring these.
const INITIAL_RETRY_DELAY_MS = 2000;
const RETRY_BACKOFF_FACTOR = 2;
const MAX_HONOURED_RETRY_AFTER_MS = 60_000;

function retryAfterMs(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const exact = headers.get("retry-after-ms");
  if (exact) {
    const parsed = Number.parseFloat(exact);
    if (!Number.isNaN(parsed)) return parsed;
  }
  const after = headers.get("retry-after");
  if (after) {
    const seconds = Number.parseFloat(after);
    if (!Number.isNaN(seconds)) return seconds * 1000;
    const at = Date.parse(after);
    if (!Number.isNaN(at)) return at - Date.now();
  }
  return undefined;
}

/** Mirrors the SDK's delay choice: `Retry-After` when sane, else backoff. */
function nextRetryDelayMs(failures: number, headers?: Headers): number {
  const backoff =
    INITIAL_RETRY_DELAY_MS * RETRY_BACKOFF_FACTOR ** (failures - 1);
  const requested = retryAfterMs(headers);
  if (
    requested != null &&
    !Number.isNaN(requested) &&
    requested >= 0 &&
    (requested < MAX_HONOURED_RETRY_AFTER_MS || requested < backoff)
  ) {
    return requested;
  }
  return backoff;
}

function reportTransientFailure(status?: number, headers?: Headers): void {
  const context = reporting.getStore();
  if (!context) return;
  context.failures++;
  // never promise an attempt the budget won't fund
  if (context.failures > llmMaxRetries()) return;
  context.notify({
    attempt: context.failures,
    status,
    delayMs: nextRetryDelayMs(context.failures, headers),
  });
}

/**
 * A call that got a real answer ends the retry cycle, so the next failure
 * starts counting from the SDK's initial delay again — which is exactly how
 * the SDK scopes its own backoff, one cycle per model call.
 */
function reportSettled(): void {
  const context = reporting.getStore();
  if (context) context.failures = 0;
}

/** Mirrors the SDK's own retryability rule, so this logs what it will retry. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Host and path only — never the query string, which can carry credentials. */
function describeUrl(input: Parameters<FetchFunction>[0]): string {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw;
  }
}

/**
 * Logs transient upstream failures as they happen.
 *
 * Exhausting the budget is already visible — the SDK's `RetryError` says
 * "Failed after N attempts" and every call site logs the error it caught. What
 * isn't visible is a blip that *recovered*: the retry succeeds and the turn
 * looks perfectly healthy, so a provider degrading under you shows up as
 * nothing at all until it starts failing outright.
 *
 * So this logs at the transport layer, where a failed attempt is observable
 * whether or not a later one succeeds. It only reports what the SDK considers
 * retryable, which keeps it from double-logging permanent failures the call
 * site will report anyway. Aborts and timeouts are the caller's decision, not
 * an upstream problem, and stay silent. Responses and errors pass through
 * untouched.
 */
export const retryLoggingFetch: FetchFunction = async (input, init) => {
  try {
    const response = await fetch(input, init);
    if (isTransientStatus(response.status)) {
      logger.warn("upstream call failed, retrying if the budget allows", {
        url: describeUrl(input),
        status: response.status,
      });
      reportTransientFailure(response.status, response.headers);
    } else {
      reportSettled();
    }
    return response;
  } catch (err) {
    // an abort is the caller giving up, not the provider faltering
    if (!isAbortError(err)) {
      logger.warn("upstream call failed, retrying if the budget allows", {
        url: describeUrl(input),
        err,
      });
      reportTransientFailure();
    }
    throw err;
  }
};
