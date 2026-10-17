-- Shared core tables. Every demo writes its runs here; the site reads the public columns.
-- Times are Unix milliseconds (UTC). Columns named `pii` or `payload` hold visitor data and are
-- never served by the public API; the nightly purge clears them after 7 days.

CREATE TABLE runs (
  id           TEXT PRIMARY KEY,
  demo         TEXT NOT NULL,                       -- 'speed-to-lead', 'booking', 'invoice', 'core'
  trigger      TEXT NOT NULL,                       -- 'form', 'cron', 'email', 'retry', ...
  status       TEXT NOT NULL DEFAULT 'running'
               CHECK (status IN ('running', 'success', 'failed')),
  outcome      TEXT,                                -- public one-line result, no visitor data
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER,
  duration_ms  INTEGER,
  metric_ms    INTEGER,                             -- the demo's headline time, e.g. lead reply time
  model        TEXT,                                -- LLM that produced the answer, if any
  steps        TEXT NOT NULL DEFAULT '[]',          -- JSON [{name, status, ms, note?, model?}]
  error        TEXT,                                -- private: full error text
  failed_step  TEXT,                                -- public: which step failed
  pii          TEXT                                 -- private JSON, purged after 7 days
);
CREATE INDEX runs_started ON runs (started_at DESC);
CREATE INDEX runs_demo_started ON runs (demo, started_at DESC);

CREATE TABLE dead_letter (
  id              TEXT PRIMARY KEY,
  run_id          TEXT,
  demo            TEXT NOT NULL,
  job             TEXT NOT NULL,                    -- handler name in the job registry
  payload         TEXT NOT NULL,                    -- private JSON the handler needs to retry
  error           TEXT NOT NULL,                    -- private: last error text
  attempts        INTEGER NOT NULL DEFAULT 0,       -- retries made so far
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'resolved', 'abandoned')),
  next_attempt_at INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX dead_letter_due ON dead_letter (status, next_attempt_at);

-- Per-IP daily caps. The key is a salted hash of bucket + day + IP; the IP itself is never stored.
CREATE TABLE rate_limits (
  key    TEXT PRIMARY KEY,
  day    TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX rate_limits_day ON rate_limits (day);

-- Daily counters: emails sent (the global send cap), reminders sent, and so on.
CREATE TABLE counters (
  day    TEXT NOT NULL,
  name   TEXT NOT NULL,
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name)
);

-- Calendar events the demos created, so the purge can cancel them after 7 days.
CREATE TABLE calendar_events (
  event_id    TEXT PRIMARY KEY,
  demo        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Small key-value state, e.g. the last cron tick.
CREATE TABLE kv_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
