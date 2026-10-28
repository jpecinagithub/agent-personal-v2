-- F2 / T-V2-015..022: person details, profile drafts, field mappings,
-- pending screening questions, and a confirmation state on declared facts.
-- All new tables are additive; F1 tables and their history are untouched.
-- Drafts are the only way a profile configuration changes: a draft is
-- edited freely and, on confirmation, becomes a new profile version with
-- an effective date and a snapshot, in one transaction (see drafts.mjs).
CREATE TABLE IF NOT EXISTS profile_drafts (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  base_version INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  snapshot_id TEXT REFERENCES profile_snapshots(id),
  effective_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS field_mappings (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  field_key TEXT NOT NULL,
  source_field TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (source, field_key)
);

CREATE TABLE IF NOT EXISTS pending_questions (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES persons(id),
  concept TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  question_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  answered_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS pending_questions_open_idx
  ON pending_questions (person_id, concept, scope) WHERE status = 'pending';

-- Person details live apart from the F1 contact blob so identity,
-- languages, authorisations, availability, exclusions, desired roles,
-- locations, salary expectations, employment and education are each
-- validated fields (see person.mjs), never free text.
ALTER TABLE persons ADD COLUMN details_json TEXT NOT NULL DEFAULT '{}';

-- A fact is only usable as an answer when it is confirmed. Facts in
-- 'pending' confirmation state are listed but never resolve answers.
ALTER TABLE declared_facts ADD COLUMN confirmation_state TEXT NOT NULL DEFAULT 'confirmed';
