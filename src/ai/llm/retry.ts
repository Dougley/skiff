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
    }
    return response;
  } catch (err) {
    if (!isAbortError(err)) {
      logger.warn("upstream call failed, retrying if the budget allows", {
        url: describeUrl(input),
        err,
      });
    }
    throw err;
  }
};
