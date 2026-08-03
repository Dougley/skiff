---
name: gated-present
description: Needs an env var the test provides.
requires:
  env:
    - SKIFF_TEST_GATE_ENV_VAR
---
Runs when the gate env var is present.
