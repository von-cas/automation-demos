import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { Run } from '../src/core/runs';
import { env, withEnv } from './helpers';
import type { Env } from '../src/env';

async function call(path: string, init: RequestInit = {}, e: Env = env) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://automation-demos.example${path}`, init) as never, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('API', () => {
  it('health reports which integrations are configured, as booleans only', async () => {
    const res = await call('/api/health', {}, withEnv({ GEMINI_API_KEY: 'super-secret-value' }));
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; configured: Record<string, boolean> }>();
    expect(body.ok).toBe(true);
    expect(body.configured.gemini).toBe(true);
    expect(body.configured.google).toBe(false);
    expect(JSON.stringify(body)).not.toContain('super-secret-value');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('serves the public feed without private columns', async () => {
    const run = await Run.start(env, { demo: 'api-demo', trigger: 'form', pii: { email: 'hidden@example.com' } });
    await run.succeed('done');
    const list = await (await call('/api/runs?demo=api-demo')).json<{ runs: { id: string }[] }>();
    expect(list.runs.map((r) => r.id)).toEqual([run.id]);
    const one = await call(`/api/runs/${run.id}`);
    expect(one.status).toBe(200);
    expect(await one.text()).not.toContain('hidden@example.com');
    expect((await call('/api/runs/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await call('/api/runs?demo=DROP%20TABLE')).status).toBe(400);
  });

  it('serves stats and the dead-letter list', async () => {
    const s = await (await call('/api/stats')).json<{ runs_24h: number; demos: unknown[] }>();
    expect(typeof s.runs_24h).toBe('number');
    expect(Array.isArray(s.demos)).toBe(true);
    expect((await call('/api/dead-letter')).status).toBe(200);
  });

  it('CORS: allows the site origin, not others', async () => {
    const ok = await call('/api/stats', { headers: { origin: 'https://vondemo.pages.dev' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://vondemo.pages.dev');
    const bad = await call('/api/stats', { headers: { origin: 'https://evil.example' } });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await call('/api/runs', { method: 'OPTIONS', headers: { origin: 'https://vondemo.pages.dev' } });
    expect(pre.status).toBe(204);
  });

  it('retry needs Turnstile or the admin token', async () => {
    const id = '11111111-1111-1111-1111-111111111111';
    const anon = await call(`/api/dead-letter/${id}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"turnstile":"x"}' });
    expect(anon.status).toBe(503); // Turnstile not configured in tests: fails closed
    const admin = await call(`/api/dead-letter/${id}/retry`, { method: 'POST', headers: { authorization: 'Bearer test-admin-token' } });
    expect(await admin.json()).toEqual({ id, status: 'skipped', reason: 'not_found' });
  });

  it('self-test is admin only', async () => {
    expect((await call('/api/admin/selftest', { method: 'POST' })).status).toBe(401);
    expect((await call('/api/admin/selftest', { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    const ok = await call('/api/admin/selftest', { method: 'POST', headers: { authorization: 'Bearer test-admin-token' } });
    expect(ok.status).toBe(200);
  });

  it('unknown routes are 404 JSON', async () => {
    const res = await call('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });
});
