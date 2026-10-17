// One cron trigger ("* * * * *") drives every scheduled job. Each job says when it is due.
// A job that throws is logged as a failed run and alerts Telegram (every failure, every time).
import type { Env, Fetch } from '../env';
import { alertFailure, sendTelegram } from './alerts';
import { retryDue } from './deadletter';
import { purgeExpired } from './purge';
import { Run, errorText, setState, stats } from './runs';

export interface CronJob {
  name: string;
  /** Due at this minute (UTC)? */
  due: (at: Date) => boolean;
  /** Return a short outcome to log the job as a run, or null when there was nothing to do. */
  run: (env: Env, at: Date, fetchFn: Fetch) => Promise<string | null>;
  /** Log a run even when there was nothing to do (daily jobs). */
  alwaysLog?: boolean;
}

export const every = (minutes: number) => (at: Date) => at.getUTCMinutes() % minutes === 0;
export const dailyAt = (hourUtc: number, minute = 0) => (at: Date) => at.getUTCHours() === hourUtc && at.getUTCMinutes() === minute;

const jobs: CronJob[] = [];

export function registerCron(job: CronJob): void {
  const i = jobs.findIndex((j) => j.name === job.name);
  if (i >= 0) jobs[i] = job;
  else jobs.push(job);
}

export function cronJobs(): readonly CronJob[] {
  return jobs;
}

export async function dailyDigest(env: Env, at: Date, fetchFn: Fetch): Promise<string> {
  const s = await stats(env, at.getTime());
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM dead_letter WHERE status = 'pending'").first<{ n: number }>();
  const lines = [
    'Automation demos: daily digest',
    `Runs in 24 h: ${s.runs_24h} (7-day success ${s.success_rate_7d ?? '-'}%)`,
    ...s.demos.map((d) => `- ${d.demo}: ${d.runs_24h} today, ${d.success_rate_7d ?? '-'}% ok`),
    `Emails sent today: ${s.today.emails_sent ?? 0}`,
    `Dead-letter pending: ${pending?.n ?? 0}`,
  ];
  await sendTelegram(env, lines.join('\n'), fetchFn);
  return `Digest: ${s.runs_24h} runs in 24 h`;
}

// Core jobs. Demos add theirs (follow-ups, reminders, the invoice inbox) with registerCron().
registerCron({
  name: 'dead-letter-retry',
  due: every(5),
  run: async (env, at, fetchFn) => {
    const results = await retryDue(env, at.getTime(), 5, fetchFn);
    return results.length ? `Retried ${results.length}: ${results.map((r) => r.status).join(', ')}` : null;
  },
});
registerCron({
  name: 'privacy-purge',
  due: dailyAt(18, 0), // 02:00 in Manila
  alwaysLog: true,
  run: async (env, at) => {
    const r = await purgeExpired(env, at.getTime());
    if (r.events_failed) throw new Error(`Purge could not cancel ${r.events_failed} calendar event(s)`);
    return `Purged: ${r.runs_scrubbed} runs scrubbed, ${r.dead_letter_deleted} dead-letter, ${r.events_cancelled} events`;
  },
});
registerCron({
  name: 'daily-digest',
  due: dailyAt(13, 0), // 21:00 in Manila
  alwaysLog: true,
  run: dailyDigest,
});

/** The scheduled() handler body. Jobs run one after another; one failing does not stop the rest. */
export async function dispatch(env: Env, at: Date, fetchFn: Fetch = fetch): Promise<{ ran: string[]; failed: string[] }> {
  const ran: string[] = [];
  const failed: string[] = [];
  await setState(env, 'cron:last_tick', at.toISOString(), at.getTime());
  for (const job of jobs) {
    if (!job.due(at)) continue;
    const t0 = Date.now();
    try {
      const outcome = await job.run(env, at, fetchFn);
      ran.push(job.name);
      if (outcome || job.alwaysLog) {
        const run = await Run.start(env, { demo: 'core', trigger: 'cron', live: false });
        run.steps.push({ name: job.name, status: 'ok', ms: Date.now() - t0 });
        await run.succeed(outcome ?? `${job.name}: nothing to do`);
      }
    } catch (err) {
      failed.push(job.name);
      const run = await Run.start(env, { demo: 'core', trigger: 'cron', live: false });
      run.steps.push({ name: job.name, status: 'failed', ms: Date.now() - t0 });
      await run.fail(err, `${job.name} failed`);
      await alertFailure(env, { demo: 'core', what: `cron ${job.name}`, runId: run.id, error: errorText(err) }, fetchFn);
    }
  }
  return { ran, failed };
}
