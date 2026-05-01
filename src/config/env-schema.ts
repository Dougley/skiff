import { z } from "zod";

export const environmentVariableSchema = z.object({
  // Discord bot tokens are base64(bot_user_id).timestamp.hmac, so we can do some basic validation on the format
  DISCORD_BOT_TOKEN: z
    .string({
      error: "DISCORD_BOT_TOKEN is required",
    })
    .min(1, "DISCORD_BOT_TOKEN cannot be empty")
    .refine((val) => {
      const parts = val.split(".");
      return (
        // tokens have 3 parts separated by dots
        parts.length === 3 &&
        // decode the first part, if its all numeric its likely valid
        /^\d+$/.test(
          Buffer.from(parts[0] as string, "base64").toString("utf-8")
        )
      );
    }, "DISCORD_BOT_TOKEN seems invalid"),
  DATABASE_URL: z.string().default("file://pg_data"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  LLM_DEFAULT_MODEL: z.string().default("gpt-4o-mini"),
  LLM_DEFAULT_PROVIDER: z
    .enum(["openai", "anthropic", "ollama"])
    .default("openai"),
  VISION_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  OLLAMA_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().default("http://localhost:11434"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_API_BASE_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_API_BASE_URL: z.string().optional(),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_PROVIDER: z
    .enum(["openai", "ollama", "disabled"])
    .default("openai"),
  MEMORY_EXTRACT_MODEL: z.string().optional(),
  RAG_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  RAG_RECENT_LIMIT: z.coerce.number().int().min(1).max(50).default(12),
  RAG_MIN_SIMILARITY: z.coerce.number().min(0).max(1).default(0.3),
  MCP_CONFIG_PATH: z.string().default("mcp.json"),
  AIEOS_FILE: z.string().default("./agent.aieos.json"),
  GUILD_ID: z.string().optional(),
  BRAVE_SEARCH_API_KEY: z.string().optional(),
  SHELL_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  SHELL_WORK_DIR: z.string().default("/home/skiff"),
  SHELL_ALLOWED_DIRS: z.string().default("/tmp"),
  CONTEXT_WINDOW_SIZE: z.coerce.number().int().min(1).default(200_000),
  HEARTBEAT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  HEARTBEAT_INTERVAL_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(1440)
    .default(30),
  HEARTBEAT_CHECKLIST_PATH: z.string().default("./HEARTBEAT.md"),
  HEARTBEAT_QUIET_HOURS_START: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default("23:00"),
  HEARTBEAT_QUIET_HOURS_END: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .default("08:00"),
  HEARTBEAT_TIMEZONE: z.string().default("UTC"),
  HEARTBEAT_ACK_MAX_CHARS: z.coerce
    .number()
    .int()
    .min(0)
    .max(1000)
    .default(300),
  ACCESS_POLICY: z.enum(["open", "disabled", "allowlist"]).default("open"),
  ACCESS_DM_POLICY: z.enum(["open", "disabled", "allowlist"]).default("open"),
  ACCESS_ALLOWED_GUILDS: z.string().default(""),
  ACCESS_ALLOWED_CHANNELS: z.string().default(""),
  ACCESS_ALLOWED_USERS: z.string().default(""),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  TOOL_CHANNEL_RULES: z.string().default(""),
  TOOL_GUILD_RULES: z.string().default(""),
  TOOL_DM_RULES: z.string().default(""),
  TOOL_USER_RULES: z.string().default(""),
  SKILLS_DIR: z.string().default("./skills"),
  SLEEP_CONSOLIDATE_LOOKBACK_DAYS: z.coerce.number().int().min(1).default(30),
  SLEEP_CONSOLIDATE_MAX_USERS: z.coerce.number().int().min(1).default(10),
  SLEEP_CONSOLIDATE_MIN_FACTS: z.coerce.number().int().min(1).default(2),
  SLEEP_DEDUPE_SIMILARITY: z.coerce.number().min(0).max(1).default(0.9),
  SLEEP_MAX_TOPICS: z.coerce.number().int().min(10).default(200),
  SLEEP_MAX_MERGES_PER_RUN: z.coerce.number().int().min(1).default(20),
  SLEEP_CLUSTER_THRESHOLD: z.coerce.number().min(0).max(1).default(0.85),
  SLEEP_MIN_CLUSTER_SIZE: z.coerce.number().int().min(2).default(5),
  SLEEP_MAX_CLUSTERS_PER_RUN: z.coerce.number().int().min(1).default(3),
  SLEEP_MAX_SAMPLES: z.coerce.number().int().min(10).default(500),
  SLEEP_NEW_TOPIC_OVERLAP_THRESHOLD: z.coerce
    .number()
    .min(0)
    .max(1)
    .default(0.85),
  SLEEP_SYNTHESIZE_LOOKBACK_DAYS: z.coerce.number().int().min(1).default(7),
  SLEEP_REFLECT_LOOKBACK_DAYS: z.coerce.number().int().min(1).default(14),
  SLEEP_REFLECT_MAX_MESSAGES: z.coerce.number().int().min(10).default(120),
  SLEEP_REFLECT_MIN_CONFIDENCE: z.coerce
    .number()
    .int()
    .min(0)
    .max(100)
    .default(70),
  SLEEP_REFLECT_MAX_ADDENDA_PER_RUN: z.coerce.number().int().min(1).default(3),
  SLEEP_PROPOSE_LOOKBACK_DAYS: z.coerce.number().int().min(1).default(7),
  SLEEP_PROPOSE_MAX_USER_MESSAGES: z.coerce.number().int().min(10).default(200),
  SLEEP_PROPOSE_MIN_CONFIDENCE: z.coerce
    .number()
    .int()
    .min(0)
    .max(100)
    .default(75),
  SLEEP_MAX_ADDENDA_PER_SCOPE: z.coerce.number().int().min(1).default(15),
});

export type EnvironmentVariables = z.infer<typeof environmentVariableSchema>;
