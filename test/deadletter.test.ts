import { afterEach, describe, expect, it } from 'vitest';
import { BACKOFF_MS, enqueueDeadLetter, listDeadLetter, registerJob, retryDeadLetter, retryDue, stepWithDeadLetter, unregisterJob } from '../src/core/deadletter';
import { Run, getRun } from '../src/core/runs';
import { env, fakeFetch, jsonResponse, withEnv } from './helpers';

const tg = withEnv({ TELEGRAM_BOT_TOKEN: 'bot-token', TELEGRAM_CHAT_ID: '42' });
const telegram = () => fakeFetch([['api.telegram.org', () => jsonResponse({ ok: true })]]);

afterEach(() => unregisterJob('flaky-send'));

describe('dead-letter', () => {
  it('stores a failed step with its payload and alerts Telegram', async () => {
    const f = telegram();
    const run = await Run.start(tg, { demo: 'speed-to-lead', trigger: 'form' });
    await expect(stepWithDeadLetter(tg, run, 'send-reply', { leadId: 'L1' }, () => Promise.reject(new Error('Gmail 503')), f.fetch)).rejects.toThrow('Gmail 503');
    const row = await env.DB.prepare('SELECT * FROM dead_letter WHERE run_id = ?').bind(run.id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ demo: 'speed-to-lead', job: 'send-reply', status: 'pending', attempts: 0, payload: '{"leadId":"L1"}' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toContain('/botbot-token/sendMessage');
    const msg = JSON.parse(f.calls[0]!.body);
    expect(msg.chat_id).toBe('42');
    expect(msg.text).toContain('speed-to-lead / send-reply');
    expect(msg.text).toContain('Gmail 503');
  });

  it('public list leaves out the payload and the error text', async () => {
    await enqueueDeadLetter(tg, { demo: 'pub', job: 'j', payload: { email: 'secret@example.com' }, error: new Error('boom secret@example.com') }, Date.now(), telegram().fetch);
    const items = await listDeadLetter(env, { demo: 'pub' });
    expect(items).toHaveLength(1);
    expect(JSON.stringify(items)).not.toContain('secret@example.com');
  });

  it('retry succeeds through the registered handler and resolves the item', async () => {
    let calls = 0;
    registerJob('flaky-send', 'speed-to-lead', async (_e, payload) => {
      calls++;
      return `Sent to lead ${String(payload.leadId)}`;
    });
    const id = await enqueueDeadLetter(tg, { demo: 'speed-to-lead', job: 'flaky-send', payload: { leadId: 'L2' }, error: 'x' }, Date.now(), telegram().fetch);
    const r = await retryDeadLetter(tg, id, Date.now(), telegram().fetch);
    expect(r.status).toBe('resolved');
    expect(calls).toBe(1);
    expect((await getRun(env, r.runId!))).toMatchObject({ status: 'success', trigger: 'retry', outcome: 'Sent to lead L2' });
    expect((await retryDeadLetter(tg, id)).status).toBe('skipped');
  });

  it('every failed retry alerts; after max attempts it is abandoned', async () => {
    registerJob('flaky-send', 'speed-to-lead', async () => {
      throw new Error('still down');
    });
    const t0 = Date.UTC(2026, 9, 21);
    const id = await enqueueDeadLetter(tg, { demo: 'speed-to-lead', job: 'flaky-send', payload: {}, error: 'x', maxAttempts: 2 }, t0, telegram().fetch);
    const f = telegram();
    const r1 = await retryDeadLetter(tg, id, t0 + 1, f.fetch);
    expect(r1.status).toBe('pending');
    const row = await env.DB.prepare('SELECT next_attempt_at, attempts FROM dead_letter WHERE id = ?').bind(id).first<{ next_attempt_at: number; attempts: number }>();
    expect(row).toEqual({ attempts: 1, next_attempt_at: t0 + 1 + BACKOFF_MS[1]! });
    const r2 = await retryDeadLetter(tg, id, t0 + 2, f.fetch);
    expect(r2.status).toBe('abandoned');
    expect(f.calls).toHaveLength(2);
    expect(JSON.parse(f.calls[1]!.body).text).toContain('gave up');
  });

  it('retryDue picks only items whose time has come', async () => {
    registerJob('flaky-send', 'due-demo', async () => 'ok');
    const t0 = Date.UTC(2026, 9, 22);
    const id = await enqueueDeadLetter(tg, { demo: 'due-demo', job: 'flaky-send', payload: {}, error: 'x' }, t0, telegram().fetch);
    expect((await retryDue(tg, t0 + 1000)).map((r) => r.id)).not.toContain(id);
    expect((await retryDue(tg, t0 + BACKOFF_MS[0]!, 50)).find((r) => r.id === id)?.status).toBe('resolved');
  });

  it('an unknown job fails the retry (and alerts) instead of crashing', async () => {
    const f = telegram();
    const id = await enqueueDeadLetter(tg, { demo: 'x', job: 'no-such-job', payload: {}, error: 'x' }, Date.now(), telegram().fetch);
    const r = await retryDeadLetter(tg, id, Date.now(), f.fetch);
    expect(r.status).toBe('pending');
    expect(JSON.parse(f.calls[0]!.body).text).toContain('No handler registered');
  });
});
