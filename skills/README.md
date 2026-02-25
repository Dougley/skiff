# Skills

Skills extend Skiff's capabilities without modifying core code. Each skill is a directory containing a `SKILL.md` file with YAML frontmatter and markdown instructions.

## How it works

1. At startup, Skiff scans the `skills/` directory and loads metadata (name + description) for each valid skill
2. A compact catalog is added to the system prompt so the LLM knows what's available
3. When the LLM decides a skill is relevant, it calls `activate_skill` to load the full instructions on demand
4. The skill's instructions are immediately available in the same conversation turn — no extra round-trip needed

This keeps baseline prompt overhead minimal: only ~20 tokens per skill until one is actually activated.

## Creating a skill

Create a subdirectory in `skills/` with a `SKILL.md` file:

```
skills/
  my-skill/
    SKILL.md
```

### SKILL.md format

```yaml
---
name: my-skill
description: A short description the LLM uses to decide when to activate this skill
version: 1.0.0
requires:
  env: [MY_API_KEY]   # optional: skip this skill if these env vars are missing
---

## Instructions

Your instructions here. This markdown body is returned to the LLM when it
calls `activate_skill("my-skill")`.

Write these as if you're briefing the LLM on how to handle the task.
```

**Frontmatter fields:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | yes | -- | Unique skill identifier |
| `description` | yes | -- | Short description shown in the skill catalog |
| `version` | no | `0.0.0` | Semantic version |
| `requires.env` | no | `[]` | Environment variables that must be set for this skill to load |

### Adding tools via MCP

If your skill needs to provide tools to the LLM, add an `mcp.json` file in the skill directory. It uses the same format as the root `mcp.json`:

```
skills/
  my-skill/
    SKILL.md
    mcp.json
```

```json
{
  "mcpServers": {
    "my-tool-server": {
      "type": "http",
      "url": "https://my-tool-server.example.com/mcp"
    }
  }
}
```

MCP servers declared by a skill are only started when the skill is activated, not at boot time.

## Disabling skills

Skills respect the existing tool rule system. Disable the `skills` tool group at any scope:

```sh
# Disable skills in all DMs
TOOL_DM_RULES=skills

# Disable skills in a specific channel
TOOL_CHANNEL_RULES=111111111111111111:skills
```

## Example

See [`hello/SKILL.md`](hello/SKILL.md) for a minimal example.
