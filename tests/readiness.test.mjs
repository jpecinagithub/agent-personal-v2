// Pliego T-V2-022 + RF-V2-020: readiness requires identity, validated
// CV, accepted required policy, apply-on-behalf consent and xAI.
// Pliego T-V2-021: an attempt snapshots the whole person, not only the
// profile and its facts. Synthetic fixtures only.
import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull, updatePersonDetails, getPerson } from "../packages/shared/person.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import { createProfileFull, profileReadiness, createAttempt, getAttempt } from "../packages/shared/profiles.mjs";
import { declareFact } from "../packages/shared/facts.mjs";
import { previewCv, confirmCvImport } from "../packages/shared/cv.mjs";
import { acceptPolicy, giveConsent } from "../packages/shared/policies.mjs";
import { createDraft, updateDraft, confirmDraft } from "../packages/shared/drafts.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-ready-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, FIXTURE_PERSON);
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const profileId = createProfileFull(db, personId, "Finance", { factRefs: [{ concept: "work_authorisation", scope: "ES" }] });
  return { db, personId, profileId };
}

function offer(db, id = "offer-ready-1") {
  db.prepare("INSERT INTO offers (id, source, ats, canonical_url, title) VALUES (?, 'greenhouse', 'greenhouse', ?, 'Finance Manager')").run(id, `https://example.test/jobs/${id}`);
  return id;
}

async function confirmFixtureCv(db, personId) {
  const txt = fs.readFileSync(fileURLToPath(new URL("./fixtures/sample.txt", import.meta.url)));
  const preview = await previewCv(db, personId, "sample.txt", txt);
  confirmCvImport(db, preview.id);
  return preview.id;
}

async function assignCvToProfile(db, profileId, cvImportId) {
  const draftId = createDraft(db, profileId);
  const profile = db.prepare("SELECT body_json FROM profiles WHERE id = ?").get(profileId);
  updateDraft(db, draftId, { ...JSON.parse(String(profile.body_json)), cv_import_id: cvImportId });
  confirmDraft(db, draftId);
}

test("each missing readiness element blocks individually; all present means ready", async () => {
  const { db, personId, profileId } = setup();
  // Nothing but identity, name and the fact is in place.
  let r = profileReadiness(db, profileId, { xaiVerified: true });
  assert.equal(r.ready, false);
  for (const key of ["cv_validated", "policy", "consent"]) {
    assert.ok(r.missing.includes(key), `missing must name ${key}, got ${r.missing.join(", ")}`);
  }
  // R4: confirming a CV for the person does NOT clear another
  // profile's cv_validated — the CV must be selected for THIS profile.
  const cvId = await confirmFixtureCv(db, personId);
  r = profileReadiness(db, profileId, { xaiVerified: true });
  assert.ok(r.missing.includes("cv_validated"), "an unassigned confirmed CV must not clear cv_validated");
  await assignCvToProfile(db, profileId, cvId);
  r = profileReadiness(db, profileId, { xaiVerified: true });
  assert.ok(!r.missing.includes("cv_validated"), "assigning the confirmed CV must clear cv_validated");
  assert.ok(r.missing.includes("policy") && r.missing.includes("consent"), "policy and consent still block");
  acceptPolicy(db, personId, "data_processing");
  r = profileReadiness(db, profileId, { xaiVerified: true });
  assert.ok(!r.missing.includes("policy"), "accepting the required policy must clear policy");
  assert.ok(r.missing.includes("consent"), "consent still blocks");
  giveConsent(db, personId, "apply_on_behalf");
  // R3: a merely configured key is not verified — unverified blocks.
  r = profileReadiness(db, profileId, { xaiVerified: false });
  assert.deepEqual(r.missing, ["xai"], "only xAI may block once everything else is in place");
  r = profileReadiness(db, profileId, { xaiVerified: true });
  assert.equal(r.ready, true, `profile must be ready, missing: ${r.missing.join(", ")}`);
  assert.deepEqual(r.missing, []);
});

test("an attempt snapshots the whole person; later identity edits never alter it", async () => {
  const { db, personId, profileId } = setup();
  const cvId = await confirmFixtureCv(db, personId);
  await assignCvToProfile(db, profileId, cvId);
  acceptPolicy(db, personId, "data_processing");
  giveConsent(db, personId, "apply_on_behalf");
  const attemptId = createAttempt(db, personId, profileId, offer(db), { xaiVerified: true });
  assert.ok(getAttempt(db, attemptId).cvSnapshot, "attempt must pin its CV snapshot");
  assert.equal(getAttempt(db, attemptId).cvSnapshot.filename, "sample.txt");
  const before = getAttempt(db, attemptId);
  assert.ok(before.personSnapshot, "attempt must carry a person snapshot");
  assert.equal(before.personSnapshot.full_name, "Test Person");
  assert.equal(before.personSnapshot.email, "test.person@example.test");
  assert.equal(before.personSnapshot.employment[0].employer, "Fixture Corp");
  // Edit identity, contacts and history immediately (allowed) — the
  // past attempt must keep the original person data unchanged.
  updatePersonDetails(db, personId, {
    ...FIXTURE_PERSON,
    full_name: "Renamed Person",
    email: "renamed.person@example.test",
    employment: [{ id: "job-9", employer: "Other Corp", title: "Controller", start: "2024-07" }],
    education: [{ id: "edu-9", institution: "Other University", title: "MSc Other", start: "2020", end: "2022" }],
  });
  const current = getPerson(db, personId);
  assert.equal(current.details.full_name, "Renamed Person");
  const after = getAttempt(db, attemptId);
  assert.equal(after.personSnapshot.full_name, "Test Person", "past attempt must keep the original identity");
  assert.equal(after.personSnapshot.email, "test.person@example.test", "past attempt must keep the original contact");
  assert.equal(after.personSnapshot.employment[0].employer, "Fixture Corp", "past attempt must keep the original history");
  // R4: assigning the CV through a draft confirmation bumped the profile
  // from version 1 to version 2, so the attempt pins version 2.
  assert.equal(after.evidence.snapshotVersion, 2);
  assert.equal(after.evidence.resolvedFacts["work_authorisation@ES"], "yes");
});
