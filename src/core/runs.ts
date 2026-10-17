// The `runs` log: every execution of every demo records its trigger, steps, timings, model and outcome.
// Public fields feed the live ops board; `error` and `pii` stay private.
import type { Env } from '../env';

export type StepStatus = 'ok' | 'failed' | 'skipped';

export interface Step {
  name: string;
  status: StepStatus;
  ms: number;
  /** Public note shown on the timeline (e.g. "score 82"). Never put visitor data here. */
  note?: string;
  model?: string;
}

export interface StepHandle {
  note?: string;
  model?: string;
}

export interface StartRunOptions {
  demo: string;
  trigger: string;
  /** Private visitor data kept with the run for 7 days (for the demo's own pages and retries). */
  pii?: Record<string, unknown>;
  /** Write each step as it finishes, so the visitor's timeline fills in live. */
  live?: boolean;
  now?: () => number;
}

export class Run {
  readonly steps: Step[] = [];
  model?: string;
  metricMs?: number;
  private finished = false;

  private constructor(
    private readonly env: Env,
    readonly id: string,
    readonly demo: string,
    readonly startedAt: number,
    private readonly live: boolean,
    private readonly now: () => number,
  ) {}

  static async start(env: Env, opts: StartRunOptions): Promise<Run> {
    const now = opts.now ?? Date.now;
    const run = new Run(env, crypto.randomUUID(), opts.demo, now(), opts.live ?? true, now);
    await env.DB.prepare(
      'INSERT INTO runs (id, demo, trigger, status, started_at, steps, pii) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(run.id, opts.demo, opts.trigger, 'running', run.startedAt, '[]', opts.pii ? JSON.stringify(opts.pii) : null)
      .run();
    return run;
  }

  /** Time one step. A thrown error marks the step failed and is rethrown. */
  async step<T>(name: string, fn: (s: StepHandle) => Promise<T> | T): Promise<T> {
    const handle: StepHandle = {};
    const t0 = this.now();
    try {
      const result = await fn(handle);
      this.push({ name, status: 'ok', ms: this.now() - t0, note: handle.note, model: handle.model });
      if (handle.model) this.model = handle.model;
      await this.flushSteps();
      return result;
    } catch (err) {
      this.push({ name, status: 'failed', ms: this.now() - t0, note: handle.note, model: handle.model });
      await this.flushSteps();
      throw err;
    }
  }

  skip(name: string, note?: string): void {
    this.push({ name, status: 'skipped', ms: 0, note });
  }

  async succeed(outcome: string): Promise<void> {
    await this.finish('success', outcome, null);
  }

  async fail(err: unknown, outcome = 'Failed'): Promise<void> {
    await this.finish('failed', outcome, errorText(err));
  }

  get failedStep(): string | undefined {
    return [...this.steps].reverse().find((s) => s.status === 'failed')?.name;
  }

  private push(step: Step): void {
    const clean: Step = { name: step.name, status: step.status, ms: Math.max(0, step.ms) };
    if (step.note) clean.note = step.note.slice(0, 160);
    if (step.model) clean.model = step.model;
    this.steps.push(clean);
  }

  private async flushSteps(): Promise<void> {
    if (!this.live) return;
    await this.env.DB.prepare('UPDATE runs SET steps = ?, model = ? WHERE id = ?')
      .bind(JSON.stringify(this.steps), this.model ?? null, this.id)
      .run();
  }

  private async finish(status: 'success' | 'failed', outcome: string, error: string | null): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    const finishedAt = this.now();
    await this.env.DB.prepare(
      `UPDATE runs SET status = ?, outcome = ?, finished_at = ?, duration_ms = ?, metric_ms = ?, model = ?,
         steps = ?, error = ?, failed_step = ? WHERE id = ?`,
    )
      .bind(
        status,
        outcome.slice(0, 200),
        finishedAt,
        finishedAt - this.startedAt,
        this.metricMs ?? null,
        this.model ?? null,
        JSON.stringify(this.steps),
        error,
        status === 'failed' ? (this.failedStep ?? null) : null,
        this.id,
      )
      .run();
  }
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 2000);
  return String(err).slice(0, 2000);
}

// ---------- public reads ----------

export interface PublicRun {
  id: string;
  demo: string;
  trigger: string;
  status: string;
  outcome: string | null;
  started_at: number;
  finished_at: number | null;
  duration_ms: number | null;
  metric_ms: number | null;
  model: string | null;
  failed_step: string | null;
  steps: Step[];
}

const PUBLIC_COLUMNS =
  'id, demo, trigger, status, outcome, started_at, finished_at, duration_ms, metric_ms, model, failed_step, steps';

function toPublic(row: Record<string, unknown>): PublicRun {
  return { ...(row as unknown as PublicRun), steps: JSON.parse(String(row.steps ?? '[]')) as Step[] };
}

export async function listRuns(env: Env, opts: { demo?: string; limit?: number; includeCore?: boolean } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const where: string[] = [];
  const binds: unknown[] = [];
  if (opts.demo) {
    where.push('demo = ?');
    binds.push(opts.demo);
  } else if (!opts.includeCore) {
    where.push("demo <> 'core'");
  }
  const sql = `SELECT ${PUBLIC_COLUMNS} FROM runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY started_at DESC LIMIT ?`;
  const { results } = await env.DB.prepare(sql).bind(...binds, limit).all();
  return results.map(toPublic);
}

export async function getRun(env: Env, id: string): Promise<PublicRun | null> {
  const row = await env.DB.prepare(`SELECT ${PUBLIC_COLUMNS} FROM runs WHERE id = ?`).bind(id).first();
  return row ? toPublic(row) : null;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

export interface DemoStats {
  demo: string;
  runs_24h: number;
  runs_7d: number;
  success_rate_7d: number | null;
  median_duration_ms_7d: number | null;
  median_metric_ms_7d: number | null;
}

/** Stats for the ops board: runs in the last 24 h, 7-day success rate and medians, today's counters. */
export async function stats(env: Env, now = Date.now()) {
  const day = 86_400_000;
  const { results } = await env.DB.prepare(
    `SELECT demo, status, started_at, duration_ms, metric_ms FROM runs
     WHERE started_at >= ? AND demo <> 'core' ORDER BY started_at DESC LIMIT 2000`,
  )
    .bind(now - 7 * day)
    .all<{ demo: string; status: string; started_at: number; duration_ms: number | null; metric_ms: number | null }>();

  const byDemo = new Map<string, typeof results>();
  for (const r of results) byDemo.set(r.demo, [...(byDemo.get(r.demo) ?? []), r]);

  const demos: DemoStats[] = [...byDemo.entries()].map(([demo, rows]) => {
    const done = rows.filter((r) => r.status !== 'running');
    const ok = done.filter((r) => r.status === 'success');
    return {
      demo,
      runs_24h: rows.filter((r) => r.started_at >= now - day).length,
      runs_7d: rows.length,
      success_rate_7d: done.length ? Math.round((ok.length / done.length) * 1000) / 10 : null,
      median_duration_ms_7d: median(ok.map((r) => r.duration_ms).filter((v): v is number => v != null)),
      median_metric_ms_7d: median(ok.map((r) => r.metric_ms).filter((v): v is number => v != null)),
    };
  });

  const allDone = results.filter((r) => r.status !== 'running');
  const { results: counterRows } = await env.DB.prepare('SELECT name, count FROM counters WHERE day = ?')
    .bind(dayKey(now))
    .all<{ name: string; count: number }>();

  return {
    generated_at: now,
    runs_24h: results.filter((r) => r.started_at >= now - day).length,
    runs_7d: results.length,
    success_rate_7d: allDone.length
      ? Math.round((allDone.filter((r) => r.status === 'success').length / allDone.length) * 1000) / 10
      : null,
    today: Object.fromEntries(counterRows.map((c) => [c.name, c.count])),
    demos,
  };
}

/** UTC day key, e.g. 2026-10-18. Caps and counters reset at 00:00 UTC (08:00 in Manila). */
export function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function bumpCounter(env: Env, name: string, by = 1, now = Date.now()): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO counters (day, name, count) VALUES (?, ?, ?)
     ON CONFLICT (day, name) DO UPDATE SET count = count + excluded.count RETURNING count`,
  )
    .bind(dayKey(now), name, by)
    .first<{ count: number }>();
  return row?.count ?? by;
}

export async function readCounter(env: Env, name: string, now = Date.now()): Promise<number> {
  const row = await env.DB.prepare('SELECT count FROM counters WHERE day = ? AND name = ?')
    .bind(dayKey(now), name)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function setState(env: Env, key: string, value: string, now = Date.now()): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
    .bind(key, value, now)
    .run();
}

export async function getState(env: Env, key: string): Promise<{ value: string; updated_at: number } | null> {
  return env.DB.prepare('SELECT value, updated_at FROM kv_state WHERE key = ?')
    .bind(key)
    .first<{ value: string; updated_at: number }>();
}
