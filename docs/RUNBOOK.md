# Runbook: a demo run failed

Every failure sends a Telegram message like:

```
Demo failure: speed-to-lead / send-reply
Run 3f0c…
Dead-letter 9a1b…
GoogleError: Google API POST /gmail/v1/users/me/messages/send failed: HTTP 503
```

## 1. Look at the run

```bash
curl -s https://automation-demos.vonc.workers.dev/api/runs/<run-id> | jq
npx wrangler d1 execute automation-demos --remote --command "SELECT error FROM runs WHERE id = '<run-id>'"
```

`failed_step` names the step. The private `error` column has the full message (cleared after 7 days).

## 2. Common causes

| Error | Cause | Fix |
|---|---|---|
| `Token exchange failed: HTTP 400 invalid_grant` | The Google refresh token expired or was revoked. An OAuth app in **Testing** mode issues tokens that expire after 7 days. | Publish the app (In production), then `npm run google:consent -- --wrangler`. |
| `Google OAuth secrets are not set` | Missing Worker secrets | `npm run secrets:put` |
| `Gemini HTTP 429` then a Workers AI answer | Gemini free-tier rate limit; the fallback handled it | Nothing, unless it happens daily: check AI Studio limits |
| `All LLM attempts failed` | Both models down or the schema is too strict | Check the prompt and schema; retry from the dead-letter list |
| `Purge could not cancel N calendar event(s)` | Calendar unreachable or Google secrets missing | Fix Google access; the purge retries the next night |
| `No handler registered for job X` | A demo renamed a job while items were pending | Re-register the old name or mark the item abandoned |

## 3. Retry

The cron retries pending items every 5 minutes (backoff 5 min, 30 min, 2 h; abandoned after 3 tries). To retry now:

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://automation-demos.vonc.workers.dev/api/dead-letter/<dead-letter-id>/retry
```

Each retry is its own run (`trigger = retry`) and a failed retry alerts again.

## 4. Check the integrations

```bash
curl -s https://automation-demos.vonc.workers.dev/api/health | jq .configured
curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://automation-demos.vonc.workers.dev/api/admin/selftest?llm=1&fallback=1&alert=1" | jq
npx wrangler tail automation-demos
```

`last_cron_tick` in `/api/health` should be under 2 minutes old. If it is not, check the Worker's cron trigger
in the Cloudflare dashboard.
