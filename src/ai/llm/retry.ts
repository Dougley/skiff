import { env } from "../../config/env.js";

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
