import type { Persona } from "./schema.js";

let currentPersona: Persona | null = null;

export const setPersona = (value: Persona): void => {
  currentPersona = value;
};

export const getPersona = (): Persona | null => currentPersona;

export const hasPersona = (): boolean => currentPersona !== null;
