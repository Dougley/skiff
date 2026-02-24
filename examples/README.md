# AIEOS Examples

These files are example AIEOS v1.1.0 agent definitions you can copy and tweak.

Files:

- `examples/agent.aieos.template.json`: a fill-in-the-blanks template.
- `examples/agent.aieos.customer-support.json`: warm, professional support agent.
- `examples/agent.aieos.research-analyst.json`: technical, thorough analysis persona.
- `examples/agent.aieos.playful-storyteller.json`: expressive, playful creative voice.
- `examples/agent.aieos.strict-sysadmin.json`: blunt, security-first operator.
- `examples/agent.aieos.kid-friendly-tutor.json`: patient, safe-for-kids teaching voice.

By default the app loads `./agent.aieos.json`. Override with:

```sh
AIEOS_FILE=examples/agent.aieos.research-analyst.json pnpm dev
```
