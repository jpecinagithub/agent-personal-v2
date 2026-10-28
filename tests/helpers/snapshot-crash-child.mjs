// Helper for the transactional profile-update test: open the database,
// BEGIN a transaction, insert the snapshot for the profile's current
// version, then exit WITHOUT committing, like a process killed mid-update.
// The uncommitted snapshot must be rolled back by SQLite on recovery.
import { openDatabase } from "../../packages/shared/db.mjs";
import { randomUUID } from "node:crypto";

const [, , dbPath, profileId] = process.argv;
const db = openDatabase(dbPath);
const profile = db.prepare("SELECT * FROM profiles WHERE id = ?").get(profileId);
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO profile_snapshots (id, profile_id, version, body_json) VALUES (?, ?, ?, ?)").run(
  randomUUID(), profileId, profile.version, profile.body_json,
);
process.exit(1);
