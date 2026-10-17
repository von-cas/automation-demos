#!/usr/bin/env node
// One-time Google consent for the demo Gmail/Calendar account. Gets a refresh token through a
// loopback redirect (with PKCE) and hands it to a command on stdin. It never prints the token.
//
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (a "Desktop app" OAuth client) in the environment.
//   npm run google:consent -- --wrangler                       # straight into the Worker secret
//   npm run google:consent -- --pipe "your-secret-manager put GOOGLE_REFRESH_TOKEN"
// Sign in as the demo account when the browser opens.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];

const args = process.argv.slice(2);
const toWrangler = args.includes('--wrangler');
const pipeIdx = args.indexOf('--pipe');
const pipeCmd = pipeIdx >= 0 ? args[pipeIdx + 1] : null;
const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = process.env;

if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the environment first.');
  process.exit(2);
}
if (!toWrangler && !pipeCmd) {
  console.error('Say where the refresh token goes: --wrangler and/or --pipe "<command reading stdin>".');
  process.exit(2);
}

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(16).toString('hex');

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/callback') return void res.writeHead(404).end();
  const done = (msg, code = 0) => {
    res.writeHead(200, { 'content-type': 'text/plain' }).end(msg);
    server.close();
    console.log(msg);
    process.exitCode = code;
  };
  if (url.searchParams.get('state') !== state) return done('State mismatch; start again.', 1);
  if (url.searchParams.get('error')) return done(`Consent refused: ${url.searchParams.get('error')}`, 1);

  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: url.searchParams.get('code') ?? '',
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const body = await tokenRes.json();
  if (!tokenRes.ok || !body.refresh_token) return done(`Token exchange failed: ${body.error ?? tokenRes.status} (no refresh token returned)`, 1);

  const granted = String(body.scope ?? '').split(' ');
  const missing = SCOPES.filter((s) => !granted.includes(s));
  const lines = [`Granted scopes: ${granted.length}${missing.length ? `; MISSING: ${missing.join(', ')}` : ', all requested'}`];
  // Google adds refresh_token_expires_in when the token is time-limited (an app in Testing mode: 7 days).
  if (body.refresh_token_expires_in) {
    const days = Math.round(Number(body.refresh_token_expires_in) / 86400);
    lines.push(`WARNING: this refresh token expires in about ${days} day(s). Publish the OAuth app (In production) and run this again.`);
  } else {
    lines.push('Refresh token has no expiry set (app is in production).');
  }

  let ok = true;
  if (pipeCmd) {
    const r = spawnSync(pipeCmd, { shell: true, input: body.refresh_token, stdio: ['pipe', 'inherit', 'inherit'] });
    lines.push(r.status === 0 ? 'Stored with the --pipe command.' : `The --pipe command failed (exit ${r.status}).`);
    ok &&= r.status === 0;
  }
  if (toWrangler) {
    const r = spawnSync('npx', ['wrangler', 'secret', 'put', 'GOOGLE_REFRESH_TOKEN'], { input: body.refresh_token, stdio: ['pipe', 'ignore', 'inherit'] });
    lines.push(r.status === 0 ? 'Set Worker secret GOOGLE_REFRESH_TOKEN.' : `wrangler secret put failed (exit ${r.status}).`);
    ok &&= r.status === 0;
  }
  done(lines.join('\n'), ok && !missing.length ? 0 : 1);
});

server.listen(0, '127.0.0.1', () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  console.log('Opening Google consent. Sign in as the demo account.\nIf no browser opens, visit:\n' + auth.toString());
  spawnSync('open', [auth.toString()]);
});
