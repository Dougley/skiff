import { z } from "zod";
import { logger } from "./logger.js";
import type { EnvironmentVariables } from "./env-schema.js";
import { environmentVariableSchema } from "./env-schema.js";

export function validateEnvironmentVariables(
  env: Record<string, string | undefined>
): EnvironmentVariables {
  const result = environmentVariableSchema.safeParse(env);
  if (!result.success) {
    logger.error(
      "Environment variable validation failed:\n",
      z.prettifyError(result.error)
    );
    throw new Error("Invalid environment variables");
  }
  return result.data;
}

export const env = validateEnvironmentVariables(process.env);
