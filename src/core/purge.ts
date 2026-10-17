// Privacy purge (nightly): visitor data and demo calendar events go after RETENTION_DAYS (7).
// Runs keep their public, anonymous fields for the stats; the private columns are cleared.
import type { Env } from '../env';
import { intVar } from '../env';
import { dayKey } from './runs';
import { GoogleClient } from './google';

export type PurgeHook = (env: Env, cutoff: number) => Promise<number>;
const hooks = new Map<string, PurgeHook>();

/** Demos register their own tables (leads, appointments, ledger rows) here. */
export function registerPurge(name: string, hook: PurgeHook): void {
  hooks.set(name, hook);
}

export interface PurgeReport {
  cutoff: number;
  runs_scrubbed: number;
  runs_deleted: number;
  dead_letter_deleted: number;
  rate_limits_deleted: number;
  counters_deleted: number;
  events_cancelled: number;
  events_failed: number;
  hooks: Record<string, number>;
}

export async function purgeExpired(env: Env, now = Date.now(), google = new GoogleClient(env)): Promise<PurgeReport> {
  const day = 86_400_000;
  const cutoff = now - intVar(env.RETENTION_DAYS, 7) * day;
  const changes = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).run()).meta.changes ?? 0;

  const report: PurgeReport = {
    cutoff,
    runs_scrubbed: await changes('UPDATE runs SET pii = NULL, error = NULL WHERE started_at < ? AND (pii IS NOT NULL OR error IS NOT NULL)', cutoff),
    runs_deleted: await changes('DELETE FROM runs WHERE started_at < ?', now - 90 * day),
    dead_letter_deleted: await changes('DELETE FROM dead_letter WHERE created_at < ?', cutoff),
    rate_limits_deleted: await changes('DELETE FROM rate_limits WHERE day < ?', dayKey(now - day)),
    counters_deleted: await changes('DELETE FROM counters WHERE day < ?', dayKey(now - 90 * day)),
    events_cancelled: 0,
    events_failed: 0,
    hooks: {},
  };

  const { results: events } = await env.DB.prepare('SELECT event_id FROM calendar_events WHERE created_at < ? LIMIT 40')
    .bind(cutoff)
    .all<{ event_id: string }>();
  if (events.length && google.isConfigured) {
    for (const e of events) {
      try {
        await google.cancelEvent(e.event_id, false);
        await env.DB.prepare('DELETE FROM calendar_events WHERE event_id = ?').bind(e.event_id).run();
        report.events_cancelled++;
      } catch (err) {
        report.events_failed++;
        console.error('purge: cancel failed', e.event_id, err instanceof Error ? err.message : String(err));
      }
    }
  } else if (events.length) {
    report.events_failed = events.length; // cannot reach Calendar yet; they stay listed for the next night
  }

  for (const [name, hook] of hooks) report.hooks[name] = await hook(env, cutoff);
  return report;
}
