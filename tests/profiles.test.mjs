// T-V2-016 / T-V2-017: ten-profile limit, fact references (not copies),
// readiness, and attempt pinning that survives later changes.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import { createProfileFull, listProfiles, archiveProfile, unarchiveProfile, deleteProfile, profileReadiness, createAttempt, getAttempt } from "../packages/shared/profiles.mjs";
import { declareFact } from "../packages/shared/facts.mjs";
import { createDraft, confirmDraft, updateDraft } from "../packages/shared/drafts.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-prof-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, FIXTURE_PERSON);
  return { db, personId };
}

function offer(db) {
  const id = "offer-fixture-1";
  db.prepare("INSERT INTO offers (id, source, ats, canonical_url, title) VALUES (?, 'greenhouse', 'greenhouse', 'https://example.test/jobs/1', 'Finance Manager')").run(id);
  return id;
}

test("at most 10 active profiles: the 11th is rejected, archiving frees a slot", () => {
  const { db, personId } = setup();
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(createProfileFull(db, personId, `Profile ${i}`, { focus: "Finance" }));
  assert.throws(() => createProfileFull(db, personId, "Profile 11", { focus: "Finance" }), /at most 10 active profiles/);
  archiveProfile(db, ids[0]);
  const extra = createProfileFull(db, personId, "Profile 11", { focus: "Finance" });
  assert.ok(extra);
  assert.throws(() => unarchiveProfile(db, ids[0]), /at most 10 active profiles/);
  assert.equal(listProfiles(db, personId).filter((p) => !p.archived).length, 10);
});

test("profiles reference facts, they do not copy them", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const profileId = createProfileFull(db, personId, "Finance", { focus: "Finance", factRefs: [{ concept: "work_authorisation", scope: "ES" }] });
  // Changing the fact value changes what the reference resolves to, but
  // the profile body itself still holds only the reference, not a copy.
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "no", provenance: "user" });
  const profile = listProfiles(db, personId).find((p) => p.id === profileId);
  assert.deepEqual(profile.body.factRefs, [{ concept: "work_authorisation", scope: "ES" }]);
  assert.ok(!JSON.stringify(profile.body).includes('"no"'), "profile body must not contain a copied fact value");
});

test("readiness explains exactly what is missing, and blocks attempts", () => {
  const { db, personId } = setup();
  const profileId = createProfileFull(db, personId, "Finance", { focus: "", factRefs: [{ concept: "work_authorisation", scope: "ES" }] });
  const readiness = profileReadiness(db, profileId);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.missing.includes("focus"));
  assert.ok(readiness.missing.some((m) => m.includes("work_authorisation")));
  assert.throws(() => createAttempt(db, personId, profileId, offer(db)), /not ready/);
});

test("sending pins the snapshot in force; later changes never alter past attempts", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const profileId = createProfileFull(db, personId, "Finance", { focus: "Finance v1", factRefs: [{ concept: "work_authorisation", scope: "ES" }] });
  const attemptId = createAttempt(db, personId, profileId, offer(db));
  const before = getAttempt(db, attemptId);
  assert.equal(before.evidence.resolvedFacts["work_authorisation@ES"], "yes");
  assert.equal(before.evidence.snapshotVersion, 1);
  // Later changes: a confirmed draft bumps the profile, and the fact changes.
  const draftId = createDraft(db, profileId);
  updateDraft(db, draftId, { focus: "Finance v2", factRefs: [{ concept: "work_authorisation", scope: "ES" }] });
  confirmDraft(db, draftId);
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "no", provenance: "user" });
  const after = getAttempt(db, attemptId);
  assert.equal(after.evidence.resolvedFacts["work_authorisation@ES"], "yes", "past attempt content must not change");
  const snapshot = db.prepare("SELECT * FROM profile_snapshots WHERE id = ?").get(before.profile_snapshot_id);
  assert.equal(JSON.parse(String(snapshot.body_json)).focus, "Finance v1", "pinned snapshot body must not change");
});

test("only archived profiles can be deleted, and never when attempts reference them", () => {
  const { db, personId } = setup();
  const profileId = createProfileFull(db, personId, "Finance", { focus: "Finance" });
  assert.throws(() => deleteProfile(db, profileId), /only an archived profile/);
  archiveProfile(db, profileId);
  deleteProfile(db, profileId);
  assert.equal(listProfiles(db, personId).length, 0);
  const usedId = createProfileFull(db, personId, "Used", { focus: "Finance" });
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  // The used profile references no facts, so make it ready via focus only
  // by using a second profile shape: readiness needs focus only here.
  createAttempt(db, personId, usedId, offer(db));
  archiveProfile(db, usedId);
  assert.throws(() => deleteProfile(db, usedId), /past attempts reference/);
});
