// Failure path: a failed step lands in the dead-letter list with its payload, Von gets a Telegram
// alert (every failure, every attempt), and the cron or the retry button runs it again.
import type { Env, Fetch } from '../env';
import { alertFailure } from './alerts';
import { Run, errorText } from './runs';

export type JobHandler = (env: Env, payload: Record<string, unknown>, run: Run) => Promise<string | void>;

const handlers = new Map<string, { demo: string; handler: JobHandler }>();

/** Demos register the steps that can be retried from the dead-letter list. */
export function registerJob(name: string, demo: string, handler: JobHandler): void {
  handlers.set(name, { demo, handler });
}

export function unregisterJob(name: string): void {
  handlers.delete(name);
}

export const BACKOFF_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

export interface DeadLetterInput {
  demo: string;
  job: string;
  payload: Record<string, unknown>;
  error: unknown;
  runId?: string;
  maxAttempts?: number;
}

/** Stores the failure and alerts. Returns the dead-letter id. */
export async function enqueueDeadLetter(env: Env, input: DeadLetterInput, now = Date.now(), fetchFn: Fetch = fetch): Promise<string> {
  const id = crypto.randomUUID();
  const error = errorText(input.error);
  const max = input.maxAttempts ?? 3;
  await env.DB.prepare(
    `INSERT INTO dead_letter (id, run_id, demo, job, payload, error, attempts, max_attempts, status, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?, ?, ?)`,
  )
    .bind(id, input.runId ?? null, input.demo, input.job, JSON.stringify(input.payload), error, max, now + BACKOFF_MS[0]!, now, now)
    .run();
  await alertFailure(env, { demo: input.demo, what: input.job, runId: input.runId, error, deadLetterId: id }, fetchFn);
  return id;
}

/**
 * Runs `fn` as a step of `run`. On failure the payload goes to the dead-letter list (with an alert)
 * and the error is rethrown so the caller can mark the run failed.
 */
export async function stepWithDeadLetter<T>(
  env: Env,
  run: Run,
  job: string,
  payload: Record<string, unknown>,
  fn: () => Promise<T>,
  fetchFn: Fetch = fetch,
): Promise<T> {
  try {
    return await run.step(job, () => fn());
  } catch (err) {
    await enqueueDeadLetter(env, { demo: run.demo, job, payload, error: err, runId: run.id }, Date.now(), fetchFn);
    throw err;
  }
}

interface DeadLetterRow {
  id: string;
  run_id: string | null;
  demo: string;
  job: string;
  payload: string;
  error: string;
  attempts: number;
  max_attempts: number;
  status: string;
  next_attempt_at: number;
  created_at: number;
  updated_at: number;
}

export type RetryResult = { id: string; status: 'resolved' | 'pending' | 'abandoned' | 'skipped'; runId?: string; reason?: string };

/** Retries one dead-letter item now. Each retry is its own run; each failure alerts. */
export async function retryDeadLetter(env: Env, id: string, now = Date.now(), fetchFn: Fetch = fetch): Promise<RetryResult> {
  const row = await env.DB.prepare('SELECT * FROM dead_letter WHERE id = ?').bind(id).first<DeadLetterRow>();
  if (!row) return { id, status: 'skipped', reason: 'not_found' };
  if (row.status !== 'pending') return { id, status: 'skipped', reason: `already ${row.status}` };

  // Claim it so the cron and the button cannot run it twice at once.
  const claim = await env.DB.prepare('UPDATE dead_letter SET updated_at = ? WHERE id = ? AND updated_at = ? AND status = ?')
    .bind(now, id, row.updated_at, 'pending')
    .run();
  if (!claim.meta.changes) return { id, status: 'skipped', reason: 'busy' };

  const entry = handlers.get(row.job);
  const attempt = row.attempts + 1;
  const run = await Run.start(env, { demo: row.demo, trigger: 'retry' });
  try {
    if (!entry) throw new Error(`No handler registered for job ${row.job}`);
    const outcome = await run.step(row.job, () => entry.handler(env, JSON.parse(row.payload) as Record<string, unknown>, run));
    await run.succeed(typeof outcome === 'string' ? outcome : `Retried ${row.job}: done`);
    await env.DB.prepare("UPDATE dead_letter SET status = 'resolved', attempts = ?, updated_at = ? WHERE id = ?").bind(attempt, now, id).run();
    return { id, status: 'resolved', runId: run.id };
  } catch (err) {
    const error = errorText(err);
    const abandoned = attempt >= row.max_attempts;
    const next = now + (BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[BACKOFF_MS.length - 1]!);
    await env.DB.prepare('UPDATE dead_letter SET status = ?, attempts = ?, error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?')
      .bind(abandoned ? 'abandoned' : 'pending', attempt, error, next, now, id)
      .run();
    await run.fail(err, `Retry ${attempt} of ${row.max_attempts} failed`);
    await alertFailure(
      env,
      { demo: row.demo, what: `${row.job} (retry${abandoned ? ', gave up' : ''})`, runId: run.id, error, attempt, maxAttempts: row.max_attempts, deadLetterId: id },
      fetchFn,
    );
    return { id, status: abandoned ? 'abandoned' : 'pending', runId: run.id };
  }
}

/** Cron: retry every pending item that is due (a few per tick, to stay inside the request budget). */
export async function retryDue(env: Env, now = Date.now(), max = 5, fetchFn: Fetch = fetch): Promise<RetryResult[]> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM dead_letter WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT ?",
  )
    .bind(now, max)
    .all<{ id: string }>();
  const out: RetryResult[] = [];
  for (const r of results) out.push(await retryDeadLetter(env, r.id, now, fetchFn));
  return out;
}

/** Public view: no payload, no error text. */
export async function listDeadLetter(env: Env, opts: { demo?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const sql = `SELECT id, run_id, demo, job, attempts, max_attempts, status, next_attempt_at, created_at, updated_at
    FROM dead_letter ${opts.demo ? 'WHERE demo = ?' : ''} ORDER BY created_at DESC LIMIT ?`;
  const stmt = env.DB.prepare(sql);
  const { results } = await (opts.demo ? stmt.bind(opts.demo, limit) : stmt.bind(limit)).all();
  return results;
}
