import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { HttpError } from '../src/core/http';
import { field, guardForm, readBody, takeIpQuota, takeSendQuota } from '../src/core/guardrails';
import { env, fakeFetch, jsonResponse, withEnv } from './helpers';

const t = withEnv({ TURNSTILE_SECRET: 'ts-secret', DAILY_SEND_CAP: '2' });
const schema = z.object({ name: field.name, email: field.email, turnstile: field.turnstile });

function post(body: unknown, ip = '203.0.113.7', extra: Record<string, string> = {}) {
  return new Request('https://x/api/form', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const turnstile = (success: boolean) => fakeFetch([['siteverify', () => jsonResponse({ success })]]);

async function expectHttp(p: Promise<unknown>, status: number, code: string) {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(HttpError);
  expect((err as HttpError).status).toBe(status);
  expect((err as HttpError).code).toBe(code);
}

describe('size limits', () => {
  it('refuses a body over the limit, by header or by real length', async () => {
    await expectHttp(readBody(new Request('https://x', { method: 'POST', body: 'x'.repeat(20) }), 10), 413, 'too_large');
    await expectHttp(readBody(new Request('https://x', { method: 'POST', body: 'x', headers: { 'content-length': '99999' } }), 10), 413, 'too_large');
    expect(await readBody(new Request('https://x', { method: 'POST', body: 'ok' }), 10)).toBe('ok');
  });
});

describe('guardForm', () => {
  it('passes a valid form and sends the secret + IP to Turnstile', async () => {
    const f = turnstile(true);
    const r = await guardForm(post({ name: 'Ana', email: 'ANA@Example.com ', turnstile: 'tok' }, '203.0.113.1'), t, { bucket: 'lead', schema, fetch: f.fetch });
    expect(r.body.email).toBe('ana@example.com');
    expect(r.quota.remaining).toBe(2);
    expect(JSON.parse(f.calls[0]!.body)).toEqual({ secret: 'ts-secret', response: 'tok', remoteip: '203.0.113.1' });
  });

  it('rejects bad JSON, wrong type, long fields and bad email', async () => {
    const f = turnstile(true);
    await expectHttp(guardForm(post('{nope'), t, { bucket: 'lead', schema, fetch: f.fetch }), 400, 'bad_json');
    await expectHttp(
      guardForm(new Request('https://x', { method: 'POST', body: '{}', headers: { 'content-type': 'text/plain' } }), t, { bucket: 'lead', schema, fetch: f.fetch }),
      415,
      'unsupported_type',
    );
    await expectHttp(guardForm(post({ name: 'x'.repeat(81), email: 'a@example.com', turnstile: 't' }), t, { bucket: 'lead', schema, fetch: f.fetch }), 400, 'invalid_input');
    await expectHttp(guardForm(post({ name: 'A', email: 'not-an-email', turnstile: 't' }), t, { bucket: 'lead', schema, fetch: f.fetch }), 400, 'invalid_input');
    expect(f.calls).toHaveLength(0);
  });

  it('rejects a failed Turnstile check', async () => {
    await expectHttp(guardForm(post({ name: 'A', email: 'a@example.com', turnstile: 'bad' }), t, { bucket: 'lead', schema, fetch: turnstile(false).fetch }), 403, 'turnstile_failed');
  });

  it('fails closed when Turnstile is not configured', async () => {
    await expectHttp(guardForm(post({ name: 'A', email: 'a@example.com', turnstile: 't' }), env, { bucket: 'lead', schema, fetch: turnstile(true).fetch }), 503, 'not_configured');
  });

  it('allows 3 per IP per day, then 429; other IPs and buckets are separate', async () => {
    const f = turnstile(true);
    const ok = { name: 'A', email: 'a@example.com', turnstile: 't' };
    for (let i = 0; i < 3; i++) await guardForm(post(ok, '198.51.100.9'), t, { bucket: 'cap', schema, fetch: f.fetch });
    await expectHttp(guardForm(post(ok, '198.51.100.9'), t, { bucket: 'cap', schema, fetch: f.fetch }), 429, 'daily_limit');
    await expect(guardForm(post(ok, '198.51.100.10'), t, { bucket: 'cap', schema, fetch: f.fetch })).resolves.toBeTruthy();
    await expect(guardForm(post(ok, '198.51.100.9'), t, { bucket: 'other', schema, fetch: f.fetch })).resolves.toBeTruthy();
  });

  it('never stores the raw IP', async () => {
    await takeIpQuota(t, 'privacy', '192.0.2.55');
    const { results } = await env.DB.prepare('SELECT key FROM rate_limits').all<{ key: string }>();
    expect(results.every((r) => !r.key.includes('192.0.2.55'))).toBe(true);
    expect(results[0]!.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resets the IP cap on the next UTC day', async () => {
    const d1 = Date.UTC(2026, 9, 18, 12);
    for (let i = 0; i < 3; i++) await takeIpQuota(t, 'day', '192.0.2.1', 3, d1);
    expect((await takeIpQuota(t, 'day', '192.0.2.1', 3, d1)).allowed).toBe(false);
    expect((await takeIpQuota(t, 'day', '192.0.2.1', 3, d1 + 86_400_000)).allowed).toBe(true);
  });
});

describe('global send cap', () => {
  it('allows DAILY_SEND_CAP emails, then reports the cap so the page shows the email instead', async () => {
    const now = Date.UTC(2026, 9, 19, 1);
    expect((await takeSendQuota(t, now)).allowed).toBe(true);
    expect((await takeSendQuota(t, now)).allowed).toBe(true);
    expect(await takeSendQuota(t, now)).toEqual({ allowed: false, sentToday: 2, cap: 2 });
    const row = await env.DB.prepare("SELECT count FROM counters WHERE name = 'emails_sent' AND day = '2026-10-19'").first();
    expect(row).toEqual({ count: 2 });
  });
});
