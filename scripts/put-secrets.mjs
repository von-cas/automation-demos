#!/usr/bin/env node
// Copies Worker secrets from environment variables into Cloudflare with `wrangler secret put`.
// Values go through stdin only; nothing is printed except the names.
//
// For each Worker secret NAME it reads AUTOMATION_DEMOS_<NAME>, then NAME. Run it under your secret
// manager so the values exist only for this process, e.g.:
//   bws run -- npm run secrets:put
//   npm run secrets:put -- GEMINI_API_KEY TELEGRAM_BOT_TOKEN     (only these)
import { spawnSync } from 'node:child_process';

const ALL = [
  'GEMINI_API_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'TURNSTILE_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'IP_HASH_SALT',
  'ADMIN_TOKEN',
];

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const unknown = wanted.filter((n) => !ALL.includes(n));
if (unknown.length) {
  console.error(`Unknown secret name(s): ${unknown.join(', ')}`);
  process.exit(2);
}

let failed = 0;
const skipped = [];
for (const name of wanted) {
  const value = process.env[`AUTOMATION_DEMOS_${name}`] ?? process.env[name];
  if (!value) {
    skipped.push(name);
    continue;
  }
  const r = spawnSync('npx', ['wrangler', 'secret', 'put', name], { input: value, stdio: ['pipe', 'ignore', 'pipe'] });
  if (r.status === 0) console.log(`set ${name}`);
  else {
    failed++;
    console.error(`FAILED ${name}: ${String(r.stderr).split('\n').find((l) => l.includes('ERROR') || l.includes('✘')) ?? `exit ${r.status}`}`);
  }
}
if (skipped.length) console.log(`not in the environment, skipped: ${skipped.join(', ')}`);
process.exit(failed ? 1 : 0);
