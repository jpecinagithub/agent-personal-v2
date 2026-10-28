// Pliego T-V2-020 (profiles, ten NON-DELETED limit) and T-V2-021
// (snapshots): fact references (not copies), readiness, and attempt
// pinning that survives later changes.
import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import { createProfileFull, listProfiles, archiveProfile, unarchiveProfile, deleteProfile, duplicateProfile, profileReadiness, createAttempt, getAttempt } from "../packages/shared/profiles.mjs";
import { declareFact } from "../packages/shared/facts.mjs";
import { createDraft, confirmDraft, updateDraft } from "../packages/shared/drafts.mjs";
import { previewCv, confirmCvImport } from "../packages/shared/cv.mjs";
import { acceptPolicy, giveConsent } from "../packages/shared/policies.mjs";

async function makeReady(db, personId) {
  const txt = fs.readFileSync(fileURLToPath(new URL("./fixtures/sample.txt", import.meta.url)));
  const preview = await previewCv(db, personId, "sample.txt", txt);
  confirmCvImport(db, preview.id);
  acceptPolicy(db, personId, "data_processing");
  giveConsent(db, personId, "apply_on_behalf");
  return preview.id;
}

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

test("at most 10 NON-DELETED profiles: archiving does NOT free a slot, deleting does", () => {
  const { db, personId } = setup();
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(createProfileFull(db, personId, `Profile ${i}`, { focus: "Finance" }));
  assert.throws(() => createProfileFull(db, personId, "Profile 11", { focus: "Finance" }), /at most 10 non-deleted profiles/);
  archiveProfile(db, ids[0]);
  assert.throws(
    () => createProfileFull(db, personId, "Profile 11", { focus: "Finance" }),
    /at most 10 non-deleted profiles/,
    "an archived profile still occupies its slot",
  );
  // Unarchiving is fine: the profile already counted toward the limit.
  unarchiveProfile(db, ids[0]);
  assert.equal(listProfiles(db, personId).length, 10);
  // Only deletion frees a slot.
  archiveProfile(db, ids[0]);
  deleteProfile(db, ids[0]);
  assert.equal(listProfiles(db, personId).length, 9, "deleted profiles are excluded from the list");
  assert.equal(listProfiles(db, personId, { includeDeleted: true }).length, 10, "deleted profiles are kept, not erased");
  // Duplicating also counts toward the limit: it fills the freed slot.
  const dup = duplicateProfile(db, ids[1]);
  assert.ok(dup);
  assert.equal(listProfiles(db, personId).length, 10);
  assert.throws(() => createProfileFull(db, personId, "Profile 11", { focus: "Finance" }), /at most 10 non-deleted profiles/);
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

test("sending pins the snapshot in force; later changes never alter past attempts", async () => {
  const { db, personId } = setup();
  const cvId = await makeReady(db, personId);
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const profileId = createProfileFull(db, personId, "Finance", { focus: "Finance v1", factRefs: [{ concept: "work_authorisation", scope: "ES" }], cv_import_id: cvId });
  const attemptId = createAttempt(db, personId, profileId, offer(db), { xaiVerified: true });
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

test("only archived profiles can be deleted, and deletion never deletes snapshots or attempts", async () => {
  const { db, personId } = setup();
  const cvId = await makeReady(db, personId);
  const profileId = createProfileFull(db, personId, "Finance", { focus: "Finance" });
  assert.throws(() => deleteProfile(db, profileId), /only an archived profile/);
  archiveProfile(db, profileId);
  deleteProfile(db, profileId);
  assert.equal(listProfiles(db, personId).length, 0, "deleted profiles are excluded from the list");
  const usedId = createProfileFull(db, personId, "Used", { focus: "Finance", cv_import_id: cvId });
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const attemptId = createAttempt(db, personId, usedId, offer(db), { xaiVerified: true });
  const before = getAttempt(db, attemptId);
  archiveProfile(db, usedId);
  deleteProfile(db, usedId);
  // Deleting is allowed even with past attempts — and the attempt and
  // its pinned snapshot must still resolve afterwards.
  const after = getAttempt(db, attemptId);
  assert.equal(after.id, before.id);
  assert.equal(after.profile_snapshot_id, before.profile_snapshot_id);
  const snapshot = db.prepare("SELECT * FROM profile_snapshots WHERE id = ?").get(after.profile_snapshot_id);
  assert.ok(snapshot, "the pinned snapshot must survive profile deletion");
  assert.equal(JSON.parse(String(snapshot.body_json)).focus, "Finance");
});
