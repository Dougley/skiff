import type { AIEOS } from "./index.js";

let currentAieos: AIEOS | null = null;

export const setAieos = (value: AIEOS): void => {
  currentAieos = value;
};

export const getAieos = (): AIEOS | null => currentAieos;

export const hasAieos = (): boolean => currentAieos !== null;
