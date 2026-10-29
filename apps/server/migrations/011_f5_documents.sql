-- F5 (T-V2-041, T-V2-046, T-V2-047): semantic aliases (verified
-- resolutions only), append-only document versions, and prepared
-- attachments. Nothing here stores attempts, queue jobs or final
-- actions: F5 generates and previews documents only.
CREATE TABLE IF NOT EXISTS semantic_aliases (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  variant_key TEXT NOT NULL,
  variant_text TEXT NOT NULL,
  concept TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  negated INTEGER NOT NULL DEFAULT 0,
  evidence_fact_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(person_id, variant_key)
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  gaps_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  conflicts_json TEXT NOT NULL DEFAULT '[]',
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(document_id, version)
);
CREATE TABLE IF NOT EXISTS document_attachments (
  id TEXT PRIMARY KEY,
  document_version_id TEXT NOT NULL,
  format TEXT NOT NULL,
  mime TEXT NOT NULL,
  filename TEXT NOT NULL,
  bytes BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'prepared',
  portal_receipt TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
