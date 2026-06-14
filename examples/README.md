# Persona Examples

These files are example Skiff persona definitions you can copy and tweak.

Files:

- `examples/agent.persona.template.json`: a fill-in-the-blanks template.
- `examples/agent.persona.customer-support.json`: warm, professional support agent (Mara).
- `examples/agent.persona.research-analyst.json`: technical, thorough analysis persona (Iris).
- `examples/agent.persona.playful-storyteller.json`: expressive, playful creative voice (Jun).
- `examples/agent.persona.strict-sysadmin.json`: blunt, security-first operator (Kade).
- `examples/agent.persona.kid-friendly-tutor.json`: patient, safe-for-kids teaching voice (Pip).

By default the app loads `./agent.persona.json`. Override with:

```sh
PERSONA_FILE=examples/agent.persona.research-analyst.json pnpm dev
```

## Format

A persona is plain JSON. Required fields are `name`, `description`, `voice`, and `examples`; the rest are optional.

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | The character's name |
| `nickname` | no | Short name, shown as `Name (nickname)` if it differs |
| `description` | yes | Prose: who they are, their role, background, and what they're like to interact with |
| `voice` | yes | Array of short traits describing how they talk |
| `principles` | no | Array: how this character actually works (verifies first, asks rarely, etc.) |
| `avoid` | no | Array of exact phrases the character never uses |
| `examples` | yes | Array of `{ "user": "...", "assistant": "..." }` few-shot exchanges |
| `meta` | no | `{ "version", "author" }`, never included in the prompt |

**The `examples` field is the most important one.** Models mirror tone, length, and attitude from concrete example exchanges far more reliably than from any description. The personas here ship 2-3 each to keep them readable; on your own main persona, aim for 3-5 covering different situations. This is what makes a persona feel like itself instead of a generic assistant.
