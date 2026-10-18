# Automation demos

Live automations you can try, with a public run log: **[vondemo.pages.dev](https://vondemo.pages.dev)**.

Each demo is a real, working flow on Cloudflare Workers. Every run is logged step by step (trigger, timings, the
AI model that answered, the outcome) and shows on the site's live ops feed. Total running cost: $0 on free tiers.

| Demo | What it proves | Status |
|---|---|---|
| Speed-to-Lead | Website lead → AI score → personal reply within 60 s → follow-ups that stop when they book | In build |
| Booking + reminders | Real calendar slots → confirmation with .ics → reminders → no-show rebooking | In build |
| Invoice to ledger | Upload or email an invoice → AI extracts fields → duplicate and total checks → ledger | In build |

Each demo also ships as an n8n workflow, a Make blueprint, a GoHighLevel field map and a Zapier build guide.

## What is here

```
src/core/        the shared core every demo uses (tested)
  runs.ts        run log: steps, durations, model, outcome; public feed + stats
  llm.ts         Gemini Flash with JSON-schema output, validation, one retry, Workers AI fallback
  google.ts      Gmail (send, read a label, labels) and Calendar (free/busy, create/cancel with Meet)
  guardrails.ts  size limits, Turnstile, 3 runs per IP per day, global daily email cap
  deadletter.ts  failed steps → dead-letter list → retries with backoff, Telegram alert on every failure
  purge.ts       nightly 7-day privacy purge (visitor data, demo calendar events)
  cron.ts        one cron trigger, many jobs
src/demos/       demo routes plug in here
migrations/      D1 schema
site/            vondemo.pages.dev: design system, live ops feed, case-study template
video/           recording, narration, render and title-card tools for the demo videos
docs/            architecture, runbook, decisions
```

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). When a run fails: [docs/RUNBOOK.md](docs/RUNBOOK.md).

## Run it locally

```bash
npm ci
npm test                 # Workers runtime + local D1, all outside calls faked
npm run typecheck
npm run db:migrate:local
cp .dev.vars.example .dev.vars   # fill in what you have; missing integrations report "not configured"
npm run dev              # Worker on http://localhost:8787
npm run dev:site         # site on http://localhost:8788
```

## Deploy

```bash
npm run db:migrate       # D1 schema, remote
npm run deploy           # Worker → automation-demos.<subdomain>.workers.dev
npm run deploy:site      # Pages project vondemo
```

Deploy pitfalls (found 2026-10-18):

- **Never run `wrangler pages project create` from a coding agent.** Wrangler 4.15x detects agents and, when the
  Pages project does not exist yet, delegates to Workers: it deploys whatever `wrangler.jsonc` sits in the folder
  (here: the API Worker, cron included) as a new Worker on `workers.dev`, and no `pages.dev` project is made.
  Create a Pages project in the dashboard or with the API (`POST /accounts/{id}/pages/projects`). Once it exists,
  `wrangler pages deploy` goes to Pages normally.
- A new cron trigger took about 10 minutes to fire for the first time (Cloudflare says up to 15).
  `last_cron_tick` in `/api/health` shows when it starts.

Case-study page notes (found 2026-10-18, FixLink page):

- Run the external link check as `npm run check:site -- --external`. Without the `--`, npm keeps the flag and the
  script skips the external links.
- A product with no Worker runs (FixLink, LiveDesk) keeps `data-demo` but drops `data-ops-feed`, so §1 shows real
  proof points instead of an empty feed.
- A video hosted on another site needs that origin in `media-src` in `site/_headers`. Keep the `.vtt` captions on this
  site: a cross-origin track also needs `crossorigin` on the video and CORS on the other host.
- Images go in as WebP. The local Homebrew ffmpeg has no WebP encoder; Pillow (`python3`, without `-I`) has one.

### Configuration (names only, never values)

Public settings live in `wrangler.jsonc` under `vars`. Secrets are set on the Worker with `wrangler secret put`,
or all at once from environment variables with `npm run secrets:put` (it reads `NAME` or `AUTOMATION_DEMOS_NAME`
and pipes each value to wrangler on stdin, so nothing is printed).

| Secret | Used for |
|---|---|
| `GEMINI_API_KEY` | Gemini Flash (primary model) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Gmail + Calendar for the demo account. Get the refresh token with `npm run google:consent -- --wrangler`. |
| `TURNSTILE_SECRET` | Spam check on every form (the site key is public and goes in the page) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Failure alerts and the daily digest |
| `IP_HASH_SALT` | Salt for the per-IP cap; raw IPs are never stored |
| `ADMIN_TOKEN` | Admin retry and `/api/admin/selftest` |

`GET /api/health` shows which integrations are configured (true/false only).

## API

| Route | |
|---|---|
| `GET /api/health` | status, last cron tick, configured integrations |
| `GET /api/runs?demo=&limit=` | latest runs, public fields only |
| `GET /api/runs/:id` | one run (a visitor's own timeline) |
| `GET /api/stats` | runs in 24 h, 7-day success rate and medians, today's counters |
| `GET /api/dead-letter?demo=` | failed steps waiting for retry (no payloads) |
| `POST /api/dead-letter/:id/retry` | retry now: Turnstile token or admin token |
| `POST /api/admin/selftest?llm=1&fallback=1&alert=1` | admin: live check of Gemini, Workers AI and Telegram |

## Privacy

Visitor details (names, emails, uploaded invoices) are stored only in private columns and deleted after 7 days by
the nightly purge. Demo calendar events are cancelled after 7 days. The public feed never shows visitor data.
Use only synthetic data with the free AI tier.

## License

MIT. Built by [Von Castro](https://voncastro.pages.dev).
