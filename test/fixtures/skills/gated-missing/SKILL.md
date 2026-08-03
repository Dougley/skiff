---
name: gated-missing
description: Needs an env var that is never set.
requires:
  env:
    - SKIFF_TEST_NEVER_SET_ENV_VAR
---
Should be skipped.
