// Supporting T-V2-021 (RF-V2-059): Form field mappings. A mapping binds one stable field key to
// one source-specific field name, for ONE source only. A mapping defined
// for Greenhouse is never applied to Lever or Ashby: getMapping takes the
// source as a required argument and the UNIQUE (source, field_key)
// constraint makes cross-source leakage impossible at the storage layer.
import { randomUUID } from "node:crypto";

export const KNOWN_SOURCES = ["greenhouse", "lever", "ashby", "smartrecruiters", "generic"];

/**
 * @param {any} db
 * @param {{source: string, fieldKey: string, sourceField: string}} mapping
 * @returns {string} mapping id
 */
export function defineMapping(db, { source, fieldKey, sourceField }) {
  if (typeof source !== "string" || source.trim() === "") throw new Error("source is required");
  if (typeof fieldKey !== "string" || fieldKey.trim() === "") throw new Error("fieldKey is required");
  if (typeof sourceField !== "string" || sourceField.trim() === "") throw new Error("sourceField is required");
  const id = randomUUID();
  db.prepare(
    "INSERT INTO field_mappings (id, source, field_key, source_field) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(source, field_key) DO UPDATE SET source_field = excluded.source_field",
  ).run(id, source.trim().toLowerCase(), fieldKey.trim(), sourceField.trim());
  const row = db.prepare("SELECT id FROM field_mappings WHERE source = ? AND field_key = ?").get(source.trim().toLowerCase(), fieldKey.trim());
  return row.id;
}

/** Returns the source-specific field name, or null when this source has no mapping for the key. */
export function getMapping(db, source, fieldKey) {
  const row = db.prepare("SELECT * FROM field_mappings WHERE source = ? AND field_key = ?").get(
    String(source).toLowerCase(), fieldKey,
  );
  return row ? row.source_field : null;
}

export function listMappings(db, source) {
  const rows = source
    ? db.prepare("SELECT * FROM field_mappings WHERE source = ? ORDER BY field_key ASC").all(String(source).toLowerCase())
    : db.prepare("SELECT * FROM field_mappings ORDER BY source ASC, field_key ASC").all();
  return rows;
}
