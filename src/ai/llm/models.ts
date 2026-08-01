import { env } from "../../config/env.js";

/**
 * Runtime model selection.
 *
 * The model is switchable per channel (`/model`) and per turn (`/ask model:`)
 * without touching `LLM_DEFAULT_MODEL` or restarting. Only the *model* moves —
 * the provider stays `LLM_DEFAULT_PROVIDER`, so reasoning options, prompt
 * caching, and token accounting keep working off the same provider they were
 * written for.
 *
 * `LLM_ALLOWED_MODELS` bounds what callers may pick. Unset means unrestricted,
 * which is fine for a private bot but worth setting anywhere `/model` is
 * reachable by people you'd rather not hand your priciest model to.
 */

/** Discord caps a slash-command option at 25 static choices. */
export const MAX_MODEL_CHOICES = 25;

/** Parsed `LLM_ALLOWED_MODELS`, de-duplicated and order-preserving. Empty = unrestricted. */
export function allowedModels(): string[] {
  return [
    ...new Set(
      env.LLM_ALLOWED_MODELS.split(",")
        .map((m) => m.trim())
        .filter((m) => m.length > 0)
    ),
  ];
}

/** True when `model` may be selected. Always true while the allowlist is empty. */
export function isModelAllowed(model: string): boolean {
  const allowed = allowedModels();
  return allowed.length === 0 || allowed.includes(model);
}

/**
 * The model a turn should actually run on.
 *
 * `override` is the conversation's stored override or a per-turn one; null or
 * an id that has since dropped off the allowlist falls back to the configured
 * default, so tightening `LLM_ALLOWED_MODELS` can't strand a channel on a
 * model you no longer want served.
 */
export function resolveModel(override?: string | null): string {
  if (!override || !isModelAllowed(override)) return env.LLM_DEFAULT_MODEL;
  return override;
}
