-- G2 re-review corrections 2026-10-28 (user review of eadf86b, R1..R6).
-- Additive only; earlier history is untouched.
-- R1: CV proposals are immutable per import. A preview no longer writes
-- shared mutable declared_facts rows: each import owns its proposal rows
-- (value + concrete provenance + document/section + confidence), and
-- only confirmation applies them, with conflicts reported, never silently
-- overwriting a confirmed fact.
CREATE TABLE IF NOT EXISTS cv_proposals (
  id TEXT PRIMARY KEY,
  cv_import_id TEXT NOT NULL REFERENCES cv_imports(id),
  person_id TEXT NOT NULL REFERENCES persons(id),
  concept TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  value_json TEXT NOT NULL,
  source_document TEXT NOT NULL DEFAULT '',
  source_section TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'proposed',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS cv_proposals_import_idx ON cv_proposals (cv_import_id);

-- The import now references its proposal rows (the old
-- candidate_fact_ids_json column held shared fact ids and is no longer
-- written; it stays for old rows only).
ALTER TABLE cv_imports ADD COLUMN candidate_proposal_ids_json TEXT NOT NULL DEFAULT '[]';

-- R3: xAI verification records. Only a fingerprint of the key is stored,
-- never the key itself. A verification is valid only for the exact key
-- fingerprint + model pair it was recorded for, so changing the key or
-- the model invalidates it automatically.
CREATE TABLE IF NOT EXISTS xai_verifications (
  id TEXT PRIMARY KEY,
  key_fingerprint TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok',
  models_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS xai_verifications_key_model_idx ON xai_verifications (key_fingerprint, model, created_at);

-- R4: an attempt pins the CV version chosen for its profile, not just
-- "some validated CV of the person".
ALTER TABLE attempts ADD COLUMN cv_import_id TEXT REFERENCES cv_imports(id);
ALTER TABLE attempts ADD COLUMN cv_snapshot_json TEXT NOT NULL DEFAULT '{}';
