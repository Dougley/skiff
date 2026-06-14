import { readFile } from "node:fs/promises";
import { type ZodError, z } from "zod";
import { type Persona, personaSchema } from "./schema.js";

export { personaSchema };
export type { Persona };

export class PersonaLoadError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "PersonaLoadError";
  }
}

const formatZodError = (error: ZodError): string => z.prettifyError(error);

export const isPersona = (value: unknown): value is Persona =>
  personaSchema.safeParse(value).success;

export const parsePersonaObject = (
  value: unknown,
  source = "object"
): Persona => {
  const result = personaSchema.safeParse(value);
  if (!result.success) {
    throw new PersonaLoadError(
      `Persona validation failed for ${source}: ${formatZodError(result.error)}`,
      result.error
    );
  }
  return result.data;
};

export const parsePersonaJson = (json: string, source = "string"): Persona => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new PersonaLoadError(`Invalid JSON in persona ${source}`, error);
  }
  return parsePersonaObject(parsed, source);
};

export const loadPersonaFile = async (filePath: string): Promise<Persona> => {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    throw new PersonaLoadError(
      `Failed to read persona file at ${filePath}`,
      error
    );
  }
  return parsePersonaJson(raw, filePath);
};
