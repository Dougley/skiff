import type { Persona } from "./schema.js";

let basePersona: Persona | null = null;

// channel-scoped in-memory overrides from set_persona_part. one channel's
// tone shift must never restyle the bot everywhere; wiped on restart.
const channelOverrides = new Map<string, Partial<Persona>>();

export const setPersona = (value: Persona): void => {
  basePersona = value;
  channelOverrides.clear();
};

export const getPersona = (channelId?: string | null): Persona | null => {
  if (!basePersona) return null;
  const override = channelId ? channelOverrides.get(channelId) : undefined;
  return override ? { ...basePersona, ...override } : basePersona;
};

export const hasPersona = (): boolean => basePersona !== null;

export const setPersonaOverride = (
  channelId: string,
  part: Partial<Persona>
): void => {
  const existing = channelOverrides.get(channelId);
  channelOverrides.set(channelId, { ...existing, ...part });
};
