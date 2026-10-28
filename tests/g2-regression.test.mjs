// G2 regression (2026-10-28, on top of main at 4deb2b2): the domain
// UI restorations and the four defects the user review identified.
// Backend contract only — the screen-level behaviour lives in the
// browser tests appended to tests/ui-browser.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull, updatePersonDetails, getPerson, validatePersonDetails } from "../packages/shared/person.mjs";
import { declareFact, listFacts, deleteFact } from "../packages/shared/facts.mjs";
import { createProfileFull, getProfileFull, presentedHistory, archiveProfile, deleteProfile, createAttempt, getAttempt } from "../packages/shared/profiles.mjs";
import { createDraft, updateDraft, confirmDraft } from "../packages/shared/drafts.mjs";
import { previewCv, confirmCvImport } from "../packages/shared/cv.mjs";
import { acceptPolicy, giveConsent } from "../packages/shared/policies.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-g2regression-"));
  return openDatabase(path.join(dir, "agentv2.db"));
}

const PERSON = {
  full_name: "Test Person",
  email: "test.person@example.test",
  desired_roles: ["Finance Manager"],
  locations: ["Madrid"],
  skills: ["accounting"],
  exclusions: ["night shifts"],
  salary_expectations: { currency: "EUR", min: 50000, max: 70000, period: "year" },
  authorisations: [
    { country: "ES", status: "authorised", valid_until: "2030-12", sponsorship_required: false, valid_from: "2025-01", source_note: "Synthetic user declaration" },
  ],
  employment: [
    { id: "job-1", employer: "Alpha Corp", title: "Analyst", start: "2020-01" },
    { id: "job-2", employer: "Beta Ltd", title: "Accountant", start: "2022-01" },
  ],
  education: [
    { id: "edu-1", institution: "Fixture University", title: "BSc Test Studies", start: "2016", end: "2020" },
  ],
};

test("regression: mobility is a validated person key, unknown values rejected", () => {
  assert.equal(validatePersonDetails({ ...PERSON, mobility: "spain" }).mobility, "spain");
  assert.throws(() => validatePersonDetails({ ...PERSON, mobility: "moon" }), /mobility must be one of/);
  assert.throws(() => validatePersonDetails({ ...PERSON, mobility: 3 }), /mobility must be one of/);
});

test("regression: a declared fact can be deleted by id, and unknown ids fail loudly", () => {
  const db = setup();
  const personId = createPersonFull(db, PERSON);
  const id = declareFact(db, { personId, concept: "english_level", value: "C1", provenance: "user" });
  assert.equal(listFacts(db, personId).length, 1);
  deleteFact(db, id);
  assert.equal(listFacts(db, personId).length, 0);
  assert.throws(() => deleteFact(db, id), /fact not found/);
});

test("regression: person defaults can be edited and deleted, and never touch existing profiles", () => {
  const db = setup();
  const personId = createPersonFull(db, PERSON);
  // A profile created from the defaults carries its own copies.
  const profileId = createProfileFull(db, personId, "Finance", {
    desired_roles: ["Finance Manager"], locations: ["Madrid"], skills: ["accounting"],
    salary_expectations: { currency: "EUR", min: 50000, max: 70000, period: "year" },
  });
  // Editing the defaults changes future seeds only.
  updatePersonDetails(db, personId, { skills: ["forecasting"], desired_roles: null });
  const person = getPerson(db, personId);
  assert.deepEqual(person.details.skills, ["forecasting"]);
  assert.equal(person.details.desired_roles, undefined, "a null patch deletes the key from the person JSON");
  const profile = getProfileFull(db, profileId);
  assert.deepEqual(profile.body.skills, ["accounting"], "existing profile keeps its own skills");
  assert.deepEqual(profile.body.desired_roles, ["Finance Manager"], "existing profile keeps its own roles");
  // Deleting the salary default removes it from the person JSON.
  updatePersonDetails(db, personId, { salary_expectations: null });
  assert.equal(getPerson(db, personId).details.salary_expectations, undefined);
});

test("regression: dynamic history follows master additions, fixed history does not", () => {
  const db = setup();
  const personId = createPersonFull(db, PERSON);
  const dynamicId = createProfileFull(db, personId, "Dynamic", {});
  const fixedId = createProfileFull(db, personId, "Fixed", { employment_ids: ["job-1"], education_ids: ["edu-1"] });
  updatePersonDetails(db, personId, {
    employment: [{ id: "job-3", employer: "Gamma SA", title: "Controller", start: "2024-01" }],
  });
  const details = getPerson(db, personId).details;
  assert.deepEqual(presentedHistory(details, getProfileFull(db, dynamicId).body).employment.map((e) => e.id), ["job-1", "job-2", "job-3"]);
  assert.deepEqual(presentedHistory(details, getProfileFull(db, fixedId).body).employment.map((e) => e.id), ["job-1"]);
});

test("regression: a draft can switch a profile from fixed to dynamic by clearing the keys", () => {
  const db = setup();
  const personId = createPersonFull(db, PERSON);
  const profileId = createProfileFull(db, personId, "Fixed", { employment_ids: ["job-1"], education_ids: [] });
  const draftId = createDraft(db, profileId);
  const body = { ...getProfileFull(db, profileId).body };
  delete body.employment_ids;
  delete body.education_ids;
  updateDraft(db, draftId, body);
  confirmDraft(db, draftId);
  const after = getProfileFull(db, profileId);
  assert.equal(after.body.employment_ids, undefined, "dynamic stores no employment key");
  assert.equal(after.body.education_ids, undefined, "dynamic stores no education key");
  assert.deepEqual(presentedHistory(getPerson(db, personId).details, after.body).employment.map((e) => e.id), ["job-1", "job-2"]);
});

test("regression: snapshots are immutable — later person/profile edits and profile deletion do not rewrite an attempt", async () => {
  const db = setup();
  const personId = createPersonFull(db, FIXTURE_PERSON);
  const txt = fs.readFileSync(new URL("./fixtures/sample.txt", import.meta.url).pathname);
  const preview = await previewCv(db, personId, "sample.txt", txt);
  confirmCvImport(db, preview.id);
  acceptPolicy(db, personId, "data_processing");
  giveConsent(db, personId, "apply_on_behalf");
  const profileId = createProfileFull(db, personId, "Finance", {
    focus: "Finance", cv_import_id: preview.id, skills: ["accounting"],
    employment_ids: ["job-1"], education_ids: [],
  });
  db.prepare("INSERT INTO offers (id, source, ats, canonical_url, title) VALUES (?, 'greenhouse', 'greenhouse', ?, 'Finance Manager')")
    .run("offer-snap-1", "https://example.test/jobs/offer-snap-1");
  const attemptId = createAttempt(db, personId, profileId, "offer-snap-1", { xaiVerified: true });
  const before = getAttempt(db, attemptId);
  const profileSnapshotBefore = String(db.prepare("SELECT body_json FROM profile_snapshots WHERE id = ?").get(before.profile_snapshot_id).body_json);
  const personSnapshotBefore = JSON.stringify(before.personSnapshot);
  // Now change everything the attempt must NOT follow: master
  // history, authorisations, facts, defaults and the live profile.
  updatePersonDetails(db, personId, {
    employment: [{ id: "job-9", employer: "Gamma SA", title: "Controller", start: "2024-01" }],
    authorisations: [{ country: "DE", status: "authorised", sponsorship_required: false }],
    skills: ["forecasting"],
  });
  declareFact(db, { personId, concept: "english_level", value: "C1", provenance: "user" });
  const draftId = createDraft(db, profileId);
  const body = { ...getProfileFull(db, profileId).body, skills: ["forecasting"] };
  delete body.employment_ids;
  updateDraft(db, draftId, body);
  confirmDraft(db, draftId);
  archiveProfile(db, profileId);
  deleteProfile(db, profileId);
  const after = getAttempt(db, attemptId);
  assert.ok(after, "the historical attempt stays readable after profile deletion");
  assert.equal(JSON.stringify(after.personSnapshot), personSnapshotBefore, "person snapshot is byte-identical");
  assert.equal(
    String(db.prepare("SELECT body_json FROM profile_snapshots WHERE id = ?").get(before.profile_snapshot_id).body_json),
    profileSnapshotBefore, "profile snapshot row is byte-identical",
  );
  assert.deepEqual(JSON.parse(profileSnapshotBefore).skills, ["accounting"], "snapshot keeps the original profile fields");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM profile_snapshots WHERE profile_id = ?").get(profileId).n, 2, "deleting a profile does not touch its snapshots");
});
