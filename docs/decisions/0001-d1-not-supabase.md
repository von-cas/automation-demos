# 0001: Cloudflare D1, not Supabase

Date: 2026-10-18 · Status: accepted

**Context.** The demos need a small database for the run log, leads, appointments and the ledger. Both free
Supabase projects are already used (LiveDesk and FixLink), and a free Supabase project pauses after 7 idle days.

**Decision.** Use Cloudflare D1 for every demo, bound to the same Worker.

**Consequences.** No keep-alive job and no extra account. The live board polls the API every few seconds instead
of using Supabase Realtime. D1 is SQLite, so the schema stays simple: JSON columns for step lists.
