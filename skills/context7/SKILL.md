---
name: context7
description: Look up current, version-specific library documentation and code examples. Use when answering questions about how to use a specific library or framework.
version: 1.0.0
requires:
  env:
    - CONTEXT7_API_KEY
---

## Instructions

Use this skill when the user asks how to use a library, framework, or API, and you need accurate, up-to-date documentation rather than relying on training data.

### Workflow

Always call `resolve-library-id` first, then `query-docs` with the resolved ID.

### Tools

**`resolve-library-id`** — map a library name to a Context7 library ID
- `libraryName`: the library to look up (e.g. `react`, `express`, `prisma`)
- `query`: the user's question or task — used to rank results by relevance

**`query-docs`** — fetch documentation and code examples for a library
- `libraryId`: the ID returned by `resolve-library-id` (e.g. `/vercel/next.js`)
- `query`: the specific question or task you need docs for

### Notes

- Call `resolve-library-id` once per library, then reuse the ID for follow-up `query-docs` calls
- Use the `query` field to be specific — it affects which docs are returned
- If multiple libraries match, pick the one with the highest benchmark score and most code snippets
