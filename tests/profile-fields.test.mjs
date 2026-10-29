// User-approved split 2026-10-29: per-profile fields live ONLY on
// profiles. The person holds universal data + the master
// employment/education history; each profile body carries its own
// desired_roles, locations, skills, exclusions, salary_expectations
// and employment_ids / education_ids selections. These tests cover
// the backend contract: validation of the profile keys, the selection
// semantics implemented by presentedHistory, and the fact that saving
// a person never touches profile fields (and the person cannot hold
// them at all).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { validateProfileBody, presentedHistory, createProfileFull, getProfileFull } from "../packages/shared/profiles.mjs";
import { createPersonFull, updatePersonDetails, getPerson } from "../packages/shared/person.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-profilefields-"));
  return openDatabase(path.join(dir, "agentv2.db"));
}

const PERSON = {
  full_name: "Test Person",
  email: "test.person@example.test",
  employment: [
    { id: "job-1", employer: "Alpha Corp", title: "Analyst", start: "2020-01" },
    { id: "job-2", employer: "Beta Ltd", title: "Accountant", start: "2022-01" },
  ],
  education: [
    { id: "edu-1", institution: "Fixture University", title: "BSc Test Studies", start: "2016", end: "2020" },
    { id: "edu-2", institution: "Other University", title: "MBA", start: "2021", end: "2022" },
  ],
};

test("redesign: profile body accepts the new per-profile keys", () => {
  const body = validateProfileBody({
    focus: "Finance",
    desired_roles: ["Finance Manager"],
    locations: ["Madrid"],
    skills: ["accounting"],
    exclusions: ["night shifts"],
    salary_expectations: { currency: "EUR", min: 50000, max: 70000, period: "year" },
    employment_ids: ["job-1"],
    education_ids: [],
  });
  assert.deepEqual(body.skills, ["accounting"]);
  assert.deepEqual(body.employment_ids, ["job-1"]);
  assert.deepEqual(body.education_ids, []);
});

test("redesign: profile body rejects malformed new keys", () => {
  assert.throws(() => validateProfileBody({ skills: "accounting" }), /skills must be an array/);
  assert.throws(() => validateProfileBody({ skills: [""] }), /each skills entry must be a non-empty string/);
  assert.throws(() => validateProfileBody({ employment_ids: [42] }), /each employment_ids entry must be a non-empty string/);
  assert.throws(() => validateProfileBody({ education_ids: "edu-1" }), /education_ids must be an array/);
  assert.throws(() => validateProfileBody({ salary_expectations: { bonus: 1 } }), /unknown salary_expectations field/);
  assert.throws(() => validateProfileBody({ salary_expectations: { min: "50000" } }), /salary_expectations.min must be a number/);
  assert.throws(() => validateProfileBody({ salary_expectations: { min: 70000, max: 50000 } }), /salary_expectations.min must not exceed max/);
  assert.throws(() => validateProfileBody({ unknown_key: 1 }), /unknown profile field/);
});

test("redesign: presentedHistory — absent means all, empty means none, subset is exact", () => {
  const details = PERSON;
  assert.deepEqual(presentedHistory(details, {}).employment.map((e) => e.id), ["job-1", "job-2"]);
  assert.deepEqual(presentedHistory(details, {}).education.map((e) => e.id), ["edu-1", "edu-2"]);
  assert.deepEqual(presentedHistory(details, { employment_ids: [], education_ids: [] }).employment, []);
  assert.deepEqual(presentedHistory(details, { employment_ids: [], education_ids: [] }).education, []);
  assert.deepEqual(presentedHistory(details, { employment_ids: ["job-2"] }).employment.map((e) => e.id), ["job-2"]);
  // Master order is preserved even when the selection lists ids in
  // another order, and unknown ids are ignored, not errors.
  assert.deepEqual(
    presentedHistory(details, { employment_ids: ["job-2", "gone", "job-1"] }).employment.map((e) => e.id),
    ["job-1", "job-2"],
  );
  assert.deepEqual(presentedHistory(details, { education_ids: ["edu-2"] }).education.map((e) => e.id), ["edu-2"]);
});

test("redesign: profile creation stores per-profile fields and selections", () => {
  const db = setup();
  const personId = createPersonFull(db, PERSON);
  const id = createProfileFull(db, personId, "Finanzas", {
    focus: "Finance",
    desired_roles: ["Finance Manager"],
    skills: ["accounting"],
    salary_expectations: { currency: "EUR", min: 50000, max: 70000, period: "year" },
    employment_ids: ["job-1"],
    education_ids: [],
  });
  const profile = getProfileFull(db, id);
  assert.deepEqual(profile.body.skills, ["accounting"]);
  assert.deepEqual(profile.body.employment_ids, ["job-1"]);
  assert.deepEqual(profile.body.education_ids, []);
  // The selection applies to the stored master history.
  const presented = presentedHistory(getPerson(db, personId).details, profile.body);
  assert.deepEqual(presented.employment.map((e) => e.id), ["job-1"]);
  assert.deepEqual(presented.education, []);
});

test("split: saving a person never touches profile search fields, and never gains them", () => {
  const db = setup();
  const personId = createPersonFull(db, PERSON);
  const profileId = createProfileFull(db, personId, "Finance", {
    desired_roles: ["Finance Manager"], locations: ["Madrid"], skills: ["accounting"],
    exclusions: ["night shifts"], salary_expectations: { currency: "EUR", min: 50000, max: 70000, period: "year" },
  });
  // This is exactly what the person form sends: identity/contact/
  // history, but none of the per-profile keys — and under the split
  // the person cannot hold them at all.
  updatePersonDetails(db, personId, { full_name: "Test Person", email: "test.person@example.test", links: ["https://example.test/x"] });
  const details = getPerson(db, personId).details;
  for (const key of ["desired_roles", "locations", "skills", "exclusions", "salary_expectations"]) {
    assert.equal(details[key], undefined, `person never gains ${key}`);
  }
  assert.deepEqual(details.links, ["https://example.test/x"]);
  const body = getProfileFull(db, profileId).body;
  assert.deepEqual(body.desired_roles, ["Finance Manager"]);
  assert.deepEqual(body.locations, ["Madrid"]);
  assert.deepEqual(body.skills, ["accounting"]);
  assert.deepEqual(body.exclusions, ["night shifts"]);
  assert.deepEqual(body.salary_expectations, { currency: "EUR", min: 50000, max: 70000, period: "year" });
});
