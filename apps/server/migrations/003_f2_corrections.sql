-- F2 corrections 2026-10-28 (G2 held open): CV imports, person snapshots,
-- soft-deleted profiles, policies/consents and settings. Additive only;
-- F1/F2 history is untouched. Profile snapshots are never deleted.
CREATE TABLE IF NOT EXISTS person_snapshots (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES persons(id),
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS cv_imports (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES persons(id),
  filename TEXT NOT NULL,
  format TEXT NOT NULL,
  extracted_text TEXT NOT NULL DEFAULT '',
  candidate_fields_json TEXT NOT NULL DEFAULT '{}',
  candidate_fact_ids_json TEXT NOT NULL DEFAULT '[]',
  warning TEXT,
  status TEXT NOT NULL DEFAULT 'preview',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  confirmed_at TEXT
);

CREATE TABLE IF NOT EXISTS policies (
  key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS consents (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES persons(id),
  consent_key TEXT NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 1,
  accepted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (person_id, consent_key)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL DEFAULT '{}'
);

-- Ten NON-DELETED profiles (pliego T-V2-020): archived profiles still
-- occupy a slot; only deleted profiles are excluded from the count.
ALTER TABLE profiles ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;

-- An attempt keeps the whole person as of send time, not only the
-- profile and its referenced facts.
ALTER TABLE attempts ADD COLUMN person_snapshot_id TEXT REFERENCES person_snapshots(id);

-- Seeded policies: data_processing is required for readiness; auto_apply
-- is opt-in and never accepted by default (RF-V2-008).
INSERT OR IGNORE INTO policies (key, title, body, required) VALUES
  ('data_processing', 'Tratamiento de datos personales', 'El agente guarda y usa tus datos declarados solo para preparar y presentar candidaturas que autorices.', 1),
  ('auto_apply', 'Aplicación automática con límites', 'Permite que el agente aplique automáticamente a ofertas descubiertas, solo dentro de los límites, perfiles y fuentes que configures. Puede desactivarse inmediatamente.', 0);

-- Automatic mode is OFF initially (pliego T-V2-022).
INSERT OR IGNORE INTO settings (key, value_json) VALUES ('auto_mode', '"off"');
