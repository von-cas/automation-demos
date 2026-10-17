import { describe, expect, it } from 'vitest';
import { Run, bumpCounter, getRun, listRuns, median, stats } from '../src/core/runs';
import { env } from './helpers';

describe('Run', () => {
  it('records steps live, then the outcome, model and duration', async () => {
    let t = 1_000;
    const run = await Run.start(env, { demo: 'speed-to-lead', trigger: 'form', pii: { email: 'a@example.com' }, now: () => t });
    await run.step('validate', () => {
      t += 5;
    });
    const mid = await getRun(env, run.id);
    expect(mid!.status).toBe('running');
    expect(mid!.steps).toEqual([{ name: 'validate', status: 'ok', ms: 5 }]);

    await run.step('qualify', (s) => {
      t += 900;
      s.model = 'gemini-test';
      s.note = 'score 82';
    });
    run.skip('ghl', 'not configured');
    run.metricMs = 905;
    t += 10;
    await run.succeed('Replied in 0.9 s');

    const r = await getRun(env, run.id);
    expect(r).toMatchObject({ status: 'success', outcome: 'Replied in 0.9 s', duration_ms: 915, metric_ms: 905, model: 'gemini-test', failed_step: null });
    expect(r!.steps.map((s) => `${s.name}:${s.status}`)).toEqual(['validate:ok', 'qualify:ok', 'ghl:skipped']);
    expect(r).not.toHaveProperty('pii');
    expect(r).not.toHaveProperty('error');
  });

  it('marks the failed step, keeps the error private, and rethrows', async () => {
    const run = await Run.start(env, { demo: 'booking', trigger: 'form' });
    await expect(run.step('create-event', () => Promise.reject(new Error('Calendar 500 for a@example.com')))).rejects.toThrow('Calendar 500');
    await run.fail(new Error('Calendar 500 for a@example.com'), 'Could not book');
    const r = await getRun(env, run.id);
    expect(r).toMatchObject({ status: 'failed', failed_step: 'create-event', outcome: 'Could not book' });
    const priv = await env.DB.prepare('SELECT error FROM runs WHERE id = ?').bind(run.id).first<{ error: string }>();
    expect(priv!.error).toContain('Calendar 500');
    expect(JSON.stringify(r)).not.toContain('a@example.com');
  });

  it('finishes only once', async () => {
    const run = await Run.start(env, { demo: 'x', trigger: 't' });
    await run.succeed('first');
    await run.fail(new Error('late'));
    expect((await getRun(env, run.id))!.status).toBe('success');
  });
});

describe('reads', () => {
  it('lists newest first, hides core runs unless asked by name, and filters by demo', async () => {
    const a = await Run.start(env, { demo: 'feed-a', trigger: 'form', now: () => 10 });
    const core = await Run.start(env, { demo: 'core', trigger: 'cron', now: () => 20 });
    const b = await Run.start(env, { demo: 'feed-b', trigger: 'form', now: () => 30 });
    const ids = (await listRuns(env, { limit: 100 })).map((r) => r.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    expect(ids).not.toContain(core.id);
    expect((await listRuns(env, { demo: 'core' })).map((r) => r.id)).toContain(core.id);
    expect((await listRuns(env, { demo: 'feed-a' })).map((r) => r.id)).toEqual([a.id]);
  });

  it('computes medians', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(3);
  });

  it('computes stats per demo and today’s counters', async () => {
    const now = Date.UTC(2026, 9, 20, 12);
    const mk = async (status: 'ok' | 'fail', ms: number, ago: number) => {
      let t = now - ago;
      const r = await Run.start(env, { demo: 'stats-demo', trigger: 'form', now: () => t, live: false });
      t += ms;
      r.metricMs = ms;
      if (status === 'ok') await r.succeed('ok');
      else await r.fail(new Error('x'));
    };
    await mk('ok', 1000, 1000);
    await mk('ok', 3000, 2000);
    await mk('fail', 50, 3000);
    await mk('ok', 2000, 3 * 86_400_000);
    await bumpCounter(env, 'reminders_sent', 2, now);
    const s = await stats(env, now);
    const d = s.demos.find((x) => x.demo === 'stats-demo')!;
    expect(d).toEqual({ demo: 'stats-demo', runs_24h: 3, runs_7d: 4, success_rate_7d: 75, median_duration_ms_7d: 2000, median_metric_ms_7d: 2000 });
    expect(s.today.reminders_sent).toBe(2);
  });
});
