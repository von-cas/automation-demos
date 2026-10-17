# 0004: Gmail and Google Calendar APIs, no custom domain

Date: 2026-10-12 · Status: accepted

**Context.** The site runs on `pages.dev` and `workers.dev`, which cannot take DNS records, so Resend and
Cloudflare Email Routing are out.

**Decision.** A dedicated demo Gmail account sends mail and holds the demo calendar, through an OAuth refresh
token kept as a Worker secret. Inbound invoices arrive by email to that account and a cron reads the label.

**Consequences.** The OAuth app must be in production, because Testing-mode refresh tokens expire after 7 days.
The sender shows the display name set in `GMAIL_FROM_NAME`. The demo's own cap (60 a day) stays far below Gmail's.
