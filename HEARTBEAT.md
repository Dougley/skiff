# Heartbeat Checklist

This file defines standing instructions for proactive monitoring. The bot checks this periodically (default: every 30 minutes during active hours).

## What to Monitor

- Check for any pending tasks or reminders in memory
- Look for urgent mentions or unread important messages
- Review any outstanding issues or blockers

## Guidelines

- Only speak up if something actually needs attention
- Be concise — no need to report "all clear"
- Stay in character with your persona
- If everything is fine, just respond with `HEARTBEAT_OK`

## Examples of What to Report

✅ "Hey, you mentioned you'd follow up with [person] yesterday — did that happen?"
✅ "There's a pending task from 3 days ago: [description]"
✅ "Weather alert: storm incoming this afternoon"

❌ "Everything looks good!" (just say HEARTBEAT_OK instead)
❌ Chatty status updates (save tokens, stay quiet when possible)
