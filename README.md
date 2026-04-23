<div align="center">

# Skiff

**A small vessel with a big personality.**

[![License: MPL-2.0](https://img.shields.io/badge/License-MPL_2.0-blue.svg)](LICENSE.md)

</div>

---

A personality-driven, multi-turn conversational agent for Discord, built with TypeScript and designed for extensibility. Skiff combines long-term memory, tool use, and customizable personas to create engaging interactions that go beyond simple Q&A.

## Features

- **Multi-turn conversations** via `/ask`, `/clear`, and @mentions
- **Long-term memory**, semantic search, automatic fact extraction, and topic knowledge
- **Multiple LLM backends**, OpenAI, Anthropic, Ollama, or any OpenAI-compatible API
- **Embedded database**, PGlite with pgvector, no external PostgreSQL needed
- **Discord tools**, look up server info, users, react to messages, and more
- **Web + browser tools**, Brave search, page fetch/markdown extraction, and Cloudflare CDP browser control
- **MCP integration**, extend capabilities with external tool servers
- **Skills**, activated on demand with minimal prompt overhead
- **Customizable personas**, define identity, psychology, and speech patterns via [AIEOS](https://aieos.org)

## Quickstart

```sh
git clone https://github.com/dougley/skiff.git
cd skiff
pnpm install
```

Create a `.env` file:

```sh
DISCORD_BOT_TOKEN=your-bot-token
OPENAI_API_KEY=sk-...
```

Run it:

```sh
pnpm build && pnpm start
```

### Docker

The included `docker-compose.yml` runs the bot alongside Ollama for fully local inference, no external API keys needed (besides your Discord token):

```sh
docker compose up -d
```

This pulls `nomic-embed-text` for embeddings and uses Ollama as the embedding provider. Set your LLM provider and model in `.env` as usual.

## Configuration

All config lives in environment variables. Only `DISCORD_BOT_TOKEN` and a LLM provider's API key are strictly required to get started, but there are many options for customizing behavior, access control, tools, and more.

### LLM

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | **required** | Your Discord bot token |
| `LLM_DEFAULT_MODEL` | `gpt-4o-mini` | Model to use for chat |
| `LLM_DEFAULT_PROVIDER` | `openai` | `openai`, `anthropic`, or `ollama` |
| `OPENAI_API_KEY` | -- | OpenAI API key |
| `OPENAI_API_BASE_URL` | -- | Custom OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` | -- | Anthropic API key |
| `ANTHROPIC_API_BASE_URL` | -- | Custom Anthropic endpoint |
| `OLLAMA_API_KEY` | -- | Ollama API key (if needed) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama endpoint |

### Memory & RAG

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model for RAG |
| `EMBEDDING_PROVIDER` | `openai` | `openai`, `ollama`, or `disabled` |
| `MEMORY_EXTRACT_MODEL` | -- | Model override for background memory extraction |
| `RAG_TOP_K` | `5` | Semantic search results to retrieve (1-20) |
| `RAG_RECENT_LIMIT` | `12` | Recent messages to include (1-50) |
| `RAG_MIN_SIMILARITY` | `0.3` | Minimum similarity score (0-1) |

### Web & Browser tools

The `web` tool group includes:

- `web_search` (Brave Search)
- `fetch_url` (HTML fetch; markdown extraction via Cloudflare when configured)
- `browser_cdp` (Cloudflare Browser Rendering via CDP: session lifecycle, tabs, navigation, snapshots, screenshots, JS evaluation, and click/type/key interactions)

| Variable | Default | Description |
|----------|---------|-------------|
| `BRAVE_SEARCH_API_KEY` | -- | API key for Brave Search (enables `web_search`) |
| `CLOUDFLARE_ACCOUNT_ID` | -- | Cloudflare account ID for Browser Rendering endpoints |
| `CLOUDFLARE_API_TOKEN` | -- | Cloudflare API token with `Browser Rendering - Edit` permission |

### Access Control

Control where and for whom the bot operates. Default is `open` (no restrictions).

> [!CAUTION]
> Leaving the bot open can lead to abuse. Consider using `allowlist` policies and specifying allowed guilds, channels, or users.

| Variable | Default | Description |
|----------|---------|-------------|
| `ACCESS_POLICY` | `open` | Guild/channel policy: `open`, `disabled`, or `allowlist` |
| `ACCESS_DM_POLICY` | `open` | DM policy: `open`, `disabled`, or `allowlist` |
| `ACCESS_ALLOWED_GUILDS` | -- | Comma-separated guild IDs (only when policy is `allowlist`) |
| `ACCESS_ALLOWED_CHANNELS` | -- | Comma-separated channel IDs (only when policy is `allowlist`) |
| `ACCESS_ALLOWED_USERS` | -- | Comma-separated user IDs (applies to both guild and DM allowlists) |
| `TOOL_CHANNEL_RULES` | -- | Per-channel tool restrictions (see below) |
| `TOOL_GUILD_RULES` | -- | Per-guild tool restrictions (see below) |
| `TOOL_DM_RULES` | -- | Tool groups disabled in all DMs (see below) |
| `TOOL_USER_RULES` | -- | Per-user tool restrictions (see below) |

When `ACCESS_POLICY` is `allowlist`, each level is checked independently — if an allowlist is empty at a given level, that level is unrestricted. For example, setting only `ACCESS_ALLOWED_GUILDS` restricts by guild but allows all channels and users within those guilds.

**Tool rules** let you disable specific tool groups at different scopes. Rules from all layers are merged (union) — if a tool group is disabled at any level, it's unavailable.

| Variable | Format | Scope |
|----------|--------|-------|
| `TOOL_GUILD_RULES` | `guildId:group1,group2;...` | Guild-wide defaults |
| `TOOL_CHANNEL_RULES` | `channelId:group1,group2;...` | Per-channel overrides |
| `TOOL_USER_RULES` | `userId:group1,group2;...` | Per-user restrictions |
| `TOOL_DM_RULES` | `group1,group2,...` | All DMs (no ID prefix) |

```sh
# Disable shell guild-wide, additionally disable web in one channel
TOOL_GUILD_RULES=999999999999999999:shell
TOOL_CHANNEL_RULES=111111111111111111:web

# Disable shell and web in all DMs
TOOL_DM_RULES=shell,web

# Restrict a specific user from using scheduler
TOOL_USER_RULES=222222222222222222:scheduler
```

Available tool groups: `discord`, `aieos`, `memory`, `topic`, `web`, `scheduler`, `heartbeat`, `shell`, `mcp`, `user-input`, `skills`.

The `web` group controls `web_search`, `fetch_url`, and `browser_cdp` together.

### Shell

Gives the LLM access to the shell. Disabled by default.

> [!NOTE]
> Skiff is designed with the assumption the agent is running in a container, or some other isolated environment with limited access to the host system. If that's not the case, be extra cautious with shell tools. Skiff makes best-effort safety measures, but a malicious or careless prompt could still cause damage.

> [!WARNING]
> Shell tools are dangerous, use with caution and only for trusted users. Always review your tool rules to ensure you don't accidentally expose powerful capabilities. 

| Variable | Default | Description |
|----------|---------|-------------|
| `SHELL_ENABLED` | `false` | Enable shell tools (`true` / `false`) |
| `SHELL_WORK_DIR` | `/home/skiff` | Working directory for shell commands |
| `SHELL_ALLOWED_DIRS` | `/tmp` | Comma-separated directories the shell can access |

### Heartbeat

Proactive monitoring — the bot periodically checks in on enabled channels.

| Variable | Default | Description |
|----------|---------|-------------|
| `HEARTBEAT_ENABLED` | `true` | Enable the heartbeat system |
| `HEARTBEAT_INTERVAL_MINUTES` | `30` | Minutes between heartbeat checks (1-1440) |
| `HEARTBEAT_CHECKLIST_PATH` | `./HEARTBEAT.md` | Markdown file with heartbeat instructions |
| `HEARTBEAT_QUIET_HOURS_START` | `23:00` | Start of quiet hours (`HH:MM`) |
| `HEARTBEAT_QUIET_HOURS_END` | `08:00` | End of quiet hours (`HH:MM`) |
| `HEARTBEAT_TIMEZONE` | `UTC` | IANA timezone for quiet hours |
| `HEARTBEAT_ACK_MAX_CHARS` | `300` | Max characters for heartbeat acknowledgments (0-1000) |

### Skills

Skills extend Skiff's capabilities without touching core code. Drop a directory with a `SKILL.md` file into `skills/` and the LLM can activate it on demand. See [`skills/README.md`](skills/README.md) for the full format and examples.

Skills are able to define their own tools in the form of MCP tool servers. When a skill is activated, its tools become available to the agent for the duration of the conversation, and are automatically removed when the conversation ends.

| Variable | Default | Description |
|----------|---------|-------------|
| `SKILLS_DIR` | `./skills` | Directory to scan for skills |

### Sleep Cycle (Dream Pass)

The sleep cycle is a background maintenance system that runs during idle periods. It consolidates memories, deduplicates knowledge, evolves the persona, and can auto-author new skills. Enabled per-guild via the `/sleep-cycle enable` Discord command. Runs in dry-run mode by default (changes are logged but not applied).

| Variable | Default | Description |
|----------|---------|-------------|
| `SLEEP_CONSOLIDATE_LOOKBACK_DAYS` | `30` | Days of user activity to scan for fact consolidation |
| `SLEEP_CONSOLIDATE_MAX_USERS` | `10` | Max users to process per pass |
| `SLEEP_CONSOLIDATE_MIN_FACTS` | `2` | Minimum facts per user to trigger consolidation |
| `SLEEP_DEDUPE_SIMILARITY` | `0.9` | Cosine similarity threshold for topic deduplication (0-1) |
| `SLEEP_MAX_TOPICS` | `200` | Max topics to scan for deduplication |
| `SLEEP_MAX_MERGES_PER_RUN` | `20` | Max topic merges per pass |
| `SLEEP_CLUSTER_THRESHOLD` | `0.85` | Cosine similarity threshold for message clustering (0-1) |
| `SLEEP_MIN_CLUSTER_SIZE` | `5` | Minimum messages in a cluster to synthesize a new topic |
| `SLEEP_MAX_CLUSTERS_PER_RUN` | `3` | Max new topics to synthesize per pass |
| `SLEEP_MAX_SAMPLES` | `500` | Max message embeddings to consider for clustering |
| `SLEEP_NEW_TOPIC_OVERLAP_THRESHOLD` | `0.85` | Skip clusters that overlap existing topics above this threshold (0-1) |
| `SLEEP_SYNTHESIZE_LOOKBACK_DAYS` | `7` | Days of messages to scan for topic synthesis |
| `SLEEP_REFLECT_LOOKBACK_DAYS` | `14` | Days of messages to reflect on for persona growth |
| `SLEEP_REFLECT_MAX_MESSAGES` | `120` | Max messages to include in persona reflection |
| `SLEEP_REFLECT_MIN_CONFIDENCE` | `70` | Minimum confidence (0-100) for a persona note to be kept |
| `SLEEP_REFLECT_MAX_ADDENDA_PER_RUN` | `3` | Max persona notes to generate per pass |
| `SLEEP_PROPOSE_LOOKBACK_DAYS` | `7` | Days of user messages to scan for skill proposals |
| `SLEEP_PROPOSE_MAX_USER_MESSAGES` | `200` | Max user messages to consider for skill proposals |
| `SLEEP_PROPOSE_MIN_CONFIDENCE` | `75` | Minimum confidence (0-100) for a skill proposal to be kept |
| `SLEEP_MAX_ADDENDA_PER_SCOPE` | `15` | Max persona addenda injected into a single system prompt |

### General

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `file://pg_data` | PGlite data directory |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` |
| `NODE_ENV` | `development` | `development`, `production`, or `test` |
| `MCP_CONFIG_PATH` | `mcp.json` | Path to MCP server config |
| `AIEOS_FILE` | `./agent.aieos.json` | Path to persona file |
| `GUILD_ID` | -- | Restrict command registration to a single guild (faster for dev) |
| `CONTEXT_WINDOW_SIZE` | `128000` | Max context window size in tokens |

## Custom Personas

Skiff's personality is defined by an [AIEOS](https://aieos.org) JSON file, a structured format for character identity, psychology, speech patterns, and motivations. Point `AIEOS_FILE` at any valid persona:

```sh
AIEOS_FILE=examples/agent.aieos.research-analyst.json pnpm dev
```

The `examples/` directory has ready-made personas:

| Persona | Style |
|---------|-------|
| **template** | Blank slate, fill in the blanks |
| **customer-support** (Mara) | Warm, empathetic, checklist-driven |
| **research-analyst** (Iris) | Methodical, evidence-first, thorough |
| **playful-storyteller** (Jun) | Creative, expressive, collaborative |
| **strict-sysadmin** (Kade) | Blunt, safety-first, asks for logs |
| **kid-friendly-tutor** (Pip) | Patient, encouraging, safe |

To build your own, copy `examples/agent.aieos.template.json` and fill it in. See `examples/README.md` for the full schema reference.

## License

[MPL-2.0](LICENSE.md)
