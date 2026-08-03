/**
 * Shared test bootstrap. Call before importing anything from src/ — env is
 * validated at module load, so src modules must be pulled in with dynamic
 * `await import(...)` after this runs.
 */
export function bootstrapTestEnv(overrides: Record<string, string> = {}): void {
  process.env.DISCORD_BOT_TOKEN = `${Buffer.from("123456789012345678").toString("base64")}.test.signature`;
  process.env.OPENAI_API_KEY = "test";
  process.env.EMBEDDING_PROVIDER = "disabled";
  process.env.DATABASE_URL = "memory://";
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
}

/** MCP config path that never exists, for tests that must run without MCP tools. */
export const MISSING_MCP_CONFIG = "/tmp/skiff-test-missing-mcp.json";
