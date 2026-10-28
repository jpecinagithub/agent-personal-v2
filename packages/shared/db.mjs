// T-V2-010: SQLite persistence via node:sqlite (Node 24, stdlib only).
// Migrations are applied in order and recorded in schema_migrations.
// Profile updates always snapshot first: history is never rewritten.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

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
    const snapshotId = snapshotProfile(db, profileId);
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
