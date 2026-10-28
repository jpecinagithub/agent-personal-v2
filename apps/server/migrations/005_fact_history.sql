-- 005: append-only history of declared-fact changes (defect fix 2026-10-28,
-- RF-V2-017 provenance truthfulness). declareFact upserts in place, so a
-- human correction of an imported fact used to erase its previous origin.
-- History rows are written only when an update actually changes the value
-- or the provenance; they are never updated or deleted by later edits.
CREATE TABLE IF NOT EXISTS fact_history (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL,
  concept TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  previous_value_json TEXT NOT NULL,
  previous_provenance TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
