import { readFile } from "node:fs/promises";
import { type ZodError, z } from "zod";
import { type AIEOS, aieosSchema } from "./schema.js";

export { aieosSchema };
export type { AIEOS };

export class AIEOSLoadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "AIEOSLoadError";
  }
}

const formatZodError = (error: ZodError): string => z.prettifyError(error);

export const isAieos = (value: unknown): value is AIEOS =>
  aieosSchema.safeParse(value).success;

export const parseAieosObject = (value: unknown, source = "object"): AIEOS => {
  const result = aieosSchema.safeParse(value);
  if (!result.success) {
    throw new AIEOSLoadError(
      `AIEOS validation failed for ${source}: ${formatZodError(result.error)}`,
      result.error
    );
  }
  return result.data;
};

export const parseAieosJson = (json: string, source = "string"): AIEOS => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new AIEOSLoadError(`Invalid JSON in AIEOS ${source}`, error);
  }
  return parseAieosObject(parsed, source);
};

export const loadAieosFile = async (filePath: string): Promise<AIEOS> => {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new AIEOSLoadError(`Failed to read AIEOS file at ${filePath}`, error);
  }
  return parseAieosJson(raw, filePath);
};
