// T-V2-010: migrations run, snapshots preserve history.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, createPerson, createProfile, updateProfile, getProfile, getSnapshot } from "../packages/shared/db.mjs";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-db-"));
  return { dir, db: openDatabase(path.join(dir, "agentv2.db")) };
}

test("migrations create all F1 tables", () => {
  const { db } = tmpDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  for (const t of ["persons", "profiles", "profile_snapshots", "declared_facts", "offers", "attempts", "jobs", "events", "usage_calls", "budgets", "schema_migrations"]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test("profile update snapshots first and never rewrites history", () => {
  const { db } = tmpDb();
  const person = createPerson(db, "Test Person");
  const profile = createProfile(db, person, "Finance", { title: "Finance Manager v1" });
  const snapshotId = updateProfile(db, profile, { title: "Finance Manager v2" });
  const snap = getSnapshot(db, snapshotId);
  assert.equal(JSON.parse(snap.body_json).title, "Finance Manager v1");
  assert.equal(getProfile(db, profile).version, 2);
  assert.equal(JSON.parse(getProfile(db, profile).body_json).title, "Finance Manager v2");
  // The old snapshot still resolves, unchanged, after a second update.
  updateProfile(db, profile, { title: "Finance Manager v3" });
  assert.equal(JSON.parse(getSnapshot(db, snapshotId).body_json).title, "Finance Manager v1");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM profile_snapshots WHERE profile_id = ?").get(profile).n, 2);
});
