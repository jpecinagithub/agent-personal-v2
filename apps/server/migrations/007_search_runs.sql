-- 007: saved-search definitions, runs and results (F3 integration,
-- T-V2-033 scheduler state + T-V2-034 ranking persistence).
-- Additive only: no existing table is altered.
-- search_definitions stores the validated definition (see
-- packages/shared/search-presets.mjs) split into queryable columns
-- plus the full criteria JSON, so a run can snapshot exactly what
-- was in force. search_runs is append-only history; a run row is
-- created in status "running" by the scheduler lock and only then
-- moves to completed / partial / interrupted / cancelled.
-- search_results.offer_id is deliberately NOT a foreign key to
-- offers(id): a result may reference a discovered candidate whose
-- canonical identity is a strong key or URL rather than a stored
-- offers row (e.g. an offer with no canonical URL). When the offer
-- could be upserted, offer_id IS the offers row id.
-- search_scheduler_state holds per-definition scheduler state that
-- is not part of the definition itself: the last local slot that ran
-- (DST ambiguous-hour guard), a single post-restart recovery flag,
-- and per-source backoff state (see search-scheduler.mjs).
CREATE TABLE IF NOT EXISTS search_definitions (
  id TEXT PRIMARY KEY,
  person_id TEXT,
  name TEXT NOT NULL,
  profile_ids_json TEXT NOT NULL DEFAULT '[]',
  criteria_json TEXT NOT NULL DEFAULT '{}',
  sources_json TEXT NOT NULL DEFAULT '[]',
  schedule_json TEXT NOT NULL DEFAULT '{}',
  action TEXT NOT NULL DEFAULT 'save',
  limits_json TEXT NOT NULL DEFAULT '{}',
  paused INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS search_runs (
  id TEXT PRIMARY KEY,
  definition_id TEXT NOT NULL REFERENCES search_definitions(id),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'partial', 'interrupted', 'cancelled')),
  criteria_snapshot_json TEXT NOT NULL DEFAULT '{}',
  cursors_json TEXT NOT NULL DEFAULT '{}',
  counts_json TEXT NOT NULL DEFAULT '{}',
  errors_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS search_results (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES search_runs(id),
  offer_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  score_json TEXT,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('recommended', 'review', 'excluded', 'pending')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS search_scheduler_state (
  definition_id TEXT PRIMARY KEY REFERENCES search_definitions(id),
  last_run_key TEXT,
  recovery_pending INTEGER NOT NULL DEFAULT 0,
  backoff_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_search_runs_definition ON search_runs (definition_id, started_at);
CREATE INDEX IF NOT EXISTS idx_search_results_run ON search_results (run_id, profile_id);
CREATE INDEX IF NOT EXISTS idx_search_results_profile ON search_results (profile_id, created_at);
