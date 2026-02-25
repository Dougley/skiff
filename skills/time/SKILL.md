---
name: time
description: Time-related tools, like telling the current time or converting timezones.
version: 1.0.0
---

## Instructions

Use this skill when someone asks about the current time, date, or needs to convert between timezones.

### Tools

**`get_current_time`** — get the current time in any timezone
- `timezone`: IANA timezone name (e.g. `America/New_York`, `Europe/Amsterdam`, `UTC`)

**`convert_time`** — convert a time from one timezone to another
- `source_timezone`: IANA timezone name for the input time
- `time`: 24-hour time string (`HH:MM`)
- `target_timezone`: IANA timezone name to convert into

Responses include the datetime, timezone name, UTC offset, and whether DST is active. Use IANA names — not abbreviations like EST or CET.
