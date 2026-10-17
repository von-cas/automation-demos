import { describe, expect, it } from 'vitest';
import { cronJobs, dailyAt, dispatch, every, registerCron } from '../src/core/cron';
import { clearTokenCache } from '../src/core/google';
import { purgeExpired, registerPurge } from '../src/core/purge';
import { Run, getState, listRuns } from '../src/core/runs';
import { env, fakeFetch, jsonResponse, withEnv } from './helpers';

const DAY = 86_400_000;
const g = withEnv({ GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r', TELEGRAM_BOT_TOKEN: 'b', TELEGRAM_CHAT_ID: '1' });

describe('schedules', () => {
  it('every(n) and dailyAt(h, m)', () => {
    expect(every(5)(new Date(Date.UTC(2026, 0, 1, 3, 10)))).toBe(true);
    expect(every(5)(new Date(Date.UTC(2026, 0, 1, 3, 11)))).toBe(false);
    expect(dailyAt(18)(new Date(Date.UTC(2026, 0, 1, 18, 0)))).toBe(true);
    expect(dailyAt(18)(new Date(Date.UTC(2026, 0, 1, 18, 1)))).toBe(false);
  });

  it('registers the core jobs once', () => {
    expect(cronJobs().map((j) => j.name)).toEqual(expect.arrayContaining(['dead-letter-retry', 'privacy-purge', 'daily-digest']));
  });
});

describe('dispatch', () => {
  it('records the tick, runs due jobs, logs failures as runs and alerts every time', async () => {
    let n = 0;
    registerCron({ name: 'test-boom', due: () => true, run: async () => { n++; throw new Error('boom'); } });
    const f = fakeFetch([['api.telegram.org', () => jsonResponse({ ok: true })]]);
    const at = new Date(Date.UTC(2026, 9, 23, 4, 7)); // not a 5-minute mark, not a daily slot
    const r1 = await dispatch(g, at, f.fetch);
    const r2 = await dispatch(g, at, f.fetch);
    expect(r1.failed).toEqual(['test-boom']);
    expect(r2.failed).toEqual(['test-boom']);
    expect(n).toBe(2);
    expect(f.calls).toHaveLength(2); // no dedupe
    expect((await getState(env, 'cron:last_tick'))!.value).toBe(at.toISOString());
    const core = await listRuns(env, { demo: 'core', limit: 5 });
    expect(core[0]).toMatchObject({ status: 'failed', failed_step: 'test-boom', trigger: 'cron' });
    registerCron({ name: 'test-boom', due: () => false, run: async () => null });
  });

  it('runs the digest at 13:00 UTC and sends it to Telegram', async () => {
    const f = fakeFetch([['api.telegram.org', () => jsonResponse({ ok: true })]]);
    const r = await dispatch(g, new Date(Date.UTC(2026, 9, 23, 13, 0)), f.fetch);
    expect(r.ran).toContain('daily-digest');
    expect(JSON.parse(f.calls[0]!.body).text).toContain('daily digest');
  });
});

describe('privacy purge', () => {
  it('scrubs visitor data after 7 days, cancels old demo events, keeps fresh data', async () => {
    clearTokenCache();
    const now = Date.UTC(2026, 9, 30);
    const old = await Run.start(env, { demo: 'p', trigger: 'form', pii: { email: 'old@example.com' }, now: () => now - 8 * DAY });
    const fresh = await Run.start(env, { demo: 'p', trigger: 'form', pii: { email: 'new@example.com' }, now: () => now - DAY });
    await env.DB.prepare('INSERT INTO calendar_events (event_id, demo, created_at) VALUES (?, ?, ?), (?, ?, ?)')
      .bind('old-ev', 'booking', now - 8 * DAY, 'new-ev', 'booking', now - DAY)
      .run();
    await env.DB.prepare(
      `INSERT INTO dead_letter (id, demo, job, payload, error, next_attempt_at, created_at, updated_at) VALUES ('dl-old', 'p', 'j', '{"email":"old@example.com"}', 'e', 0, ?, ?)`,
    )
      .bind(now - 8 * DAY, now - 8 * DAY)
      .run();
    let hookCutoff = 0;
    registerPurge('test-hook', async (_e, cutoff) => ((hookCutoff = cutoff), 3));

    const f = fakeFetch([
      ['oauth2.googleapis.com/token', () => jsonResponse({ access_token: 'at', expires_in: 3600 })],
      [/\/events\/old-ev/, () => new Response(null, { status: 204 })],
    ]);
    const { GoogleClient } = await import('../src/core/google');
    const r = await purgeExpired(g, now, new GoogleClient(g, f.fetch));

    const pii = async (id: string) => (await env.DB.prepare('SELECT pii FROM runs WHERE id = ?').bind(id).first<{ pii: string | null }>())!.pii;
    expect(await pii(old.id)).toBeNull();
    expect(await pii(fresh.id)).toContain('new@example.com');
    expect(r.events_cancelled).toBe(1);
    expect(f.calls.filter((c) => c.method === 'DELETE').map((c) => new URL(c.url).pathname)).toEqual([expect.stringContaining('/events/old-ev')]);
    const left = await env.DB.prepare('SELECT event_id FROM calendar_events ORDER BY event_id').all();
    expect(left.results.map((x) => x.event_id)).toContain('new-ev');
    expect(left.results.map((x) => x.event_id)).not.toContain('old-ev');
    expect(await env.DB.prepare("SELECT id FROM dead_letter WHERE id = 'dl-old'").first()).toBeNull();
    expect(r.hooks['test-hook']).toBe(3);
    expect(hookCutoff).toBe(now - 7 * DAY);
  });

  it('the cron job fails loudly when old events cannot be cancelled (no Google secrets)', async () => {
    const now = Date.UTC(2026, 10, 30, 18, 0);
    await env.DB.prepare('INSERT INTO calendar_events (event_id, demo, created_at) VALUES (?, ?, ?)').bind('stuck', 'booking', now - 8 * DAY).run();
    const f = fakeFetch([['api.telegram.org', () => jsonResponse({ ok: true })]]);
    const r = await dispatch(withEnv({ TELEGRAM_BOT_TOKEN: 'b', TELEGRAM_CHAT_ID: '1' }), new Date(now), f.fetch);
    expect(r.failed).toContain('privacy-purge');
    expect(f.calls.some((c) => JSON.parse(c.body).text.includes('privacy-purge'))).toBe(true);
  });
});
