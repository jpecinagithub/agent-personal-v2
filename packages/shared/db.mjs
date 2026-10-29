// T-V2-010: SQLite persistence via node:sqlite (Node 24, stdlib only).
// Migrations are applied in order and recorded in schema_migrations.
// Profile updates always snapshot first: history is never rewritten.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrateLegacyPersonSearchFields } from "./person-search-migration.mjs";
import { removeProfileFocus } from "./remove-profile-focus.mjs";

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "apps", "server", "migrations",
);

export function openDatabase(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));");
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const version = Number(file.split("_")[0]);
    const applied = db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get(version);
    if (applied) continue;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
    db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
  }
  // User order 2026-10-29 (migration 010): the profile "focus" field
  // is deleted entirely. Run before the legacy search-fields move so
  // no code path can reintroduce the key; idempotent by construction.
  removeProfileFocus(db);
  // User-approved split 2026-10-29 (migration 009): move legacy
  // person search-preference fields into profiles. Idempotent by
  // construction (see person-search-migration.mjs), so running it on
  // every open is safe: fresh databases have nothing to move, and an
  // existing database is migrated on first start after upgrade.
  migrateLegacyPersonSearchFields(db);
  return db;
}

export function createPerson(db, displayName, contact = {}) {
  const id = randomUUID();
  db.prepare("INSERT INTO persons (id, display_name, contact_json) VALUES (?, ?, ?)").run(id, displayName, JSON.stringify(contact));
  return id;
}

export function createProfile(db, personId, name, body = {}) {
  const id = randomUUID();
  db.prepare("INSERT INTO profiles (id, person_id, name, body_json) VALUES (?, ?, ?, ?)").run(id, personId, name, JSON.stringify(body));
  return id;
}

export function snapshotProfile(db, profileId) {
  const profile = db.prepare("SELECT * FROM profiles WHERE id = ?").get(profileId);
  if (!profile) throw new Error("profile not found");
  const id = randomUUID();
  db.prepare("INSERT INTO profile_snapshots (id, profile_id, version, body_json) VALUES (?, ?, ?, ?)").run(id, profileId, profile.version, profile.body_json);
  return id;
}

// Update a profile without erasing history: snapshot the current version
// first, then bump the version, in ONE transaction (BEGIN IMMEDIATE ...
// COMMIT, rollback on any failure). A crash between the snapshot insert
// and the profile update therefore leaves nothing behind: the uncommitted
// snapshot is rolled back, and retrying the same update cannot hit the
// UNIQUE (profile_id, version) constraint on a half-written snapshot.
// Existing snapshots are never modified.
export function updateProfile(db, profileId, body) {
  db.exec("BEGIN IMMEDIATE");
  try {
    // F5: a snapshot for this version may already exist (e.g. a
    // document snapshot pinned it first). Same version means same
    // body — bodies only change through this function, which bumps
    // the version — so reusing it is correct, and re-inserting would
    // wrongly fail on the UNIQUE (profile_id, version) constraint.
    const existing = db.prepare("SELECT id FROM profile_snapshots WHERE profile_id = ? AND version = ?").get(profileId, db.prepare("SELECT version FROM profiles WHERE id = ?").get(profileId)?.version);
    const snapshotId = existing ? existing.id : snapshotProfile(db, profileId);
    db.prepare("UPDATE profiles SET body_json = ?, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(JSON.stringify(body), profileId);
    db.exec("COMMIT");
    return snapshotId;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back (e.g. crash recovery); keep the original error.
    }
    throw err;
  }
}

export function getProfile(db, profileId) {
  return db.prepare("SELECT * FROM profiles WHERE id = ?").get(profileId);
}

export function getSnapshot(db, snapshotId) {
  return db.prepare("SELECT * FROM profile_snapshots WHERE id = ?").get(snapshotId);
}
