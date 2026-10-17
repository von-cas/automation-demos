# 0002: One cron trigger for every job

Date: 2026-10-18 · Status: accepted

**Context.** A Cloudflare account has 5 cron triggers in total. On 2026-10-18 none were in use (the Worker
`relay-docs` and `voice-proxy` have none). Demo 2's reminders run 10 and 2 minutes after a booking in demo mode.

**Decision.** One trigger, every minute. A dispatcher runs each registered job whose schedule matches the minute.

**Consequences.** Reminders land within a minute of their time. 1,440 invocations a day fit the free plan. Four
triggers stay free for other projects. A slow job delays the ones after it in the same tick, so jobs keep their
work small (retries take at most 5 items a tick).
