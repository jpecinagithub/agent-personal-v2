// R2 (G2 re-review): saving a person must never delete data or
// regenerate history IDs. Updates merge: absent fields survive, entries
// match by stable id (never by position), deletions are explicit.
// Synthetic fixture only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull, updatePersonDetails, getPerson, mergePersonDetails } from "../packages/shared/person.mjs";

const RICH = {
  full_name: "Synthetic Original",
  email: "original@example.test",
  links: ["https://example.test/professional-profile"],
  employment: [
    { id: "employment-alpha", employer: "Alpha Corp", title: "Analyst", start: "2019-03", end: "2022-01", links: ["https://example.test/alpha"], achievements: ["Synthetic achievement"], current: false },
    { id: "employment-beta", employer: "Beta Corp", title: "Senior Analyst", start: "2022-02", current: true },
  ],
  education: [
    { id: "edu-alpha", institution: "Synthetic University", title: "BSc Synthetic", start: "2016", end: "2020", speciality: "Accounting", status: "completed" },
  ],
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-merge-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, RICH);
  return { db, personId };
}

test("R2: saving the stored details unchanged preserves everything, including ids and date precision", () => {
  const { db, personId } = setup();
  const before = getPerson(db, personId).details;
  updatePersonDetails(db, personId, JSON.parse(JSON.stringify(before)));
  const after = getPerson(db, personId).details;
  assert.deepEqual(after, before);
  assert.deepEqual(after.employment.map((e) => e.id), ["employment-alpha", "employment-beta"]);
  assert.equal(after.education[0].start, "2016", "year-only date precision is preserved");
});

test("R2: a partial patch preserves every absent field", () => {
  const { db, personId } = setup();
  updatePersonDetails(db, personId, { phone: "+34 600 000 001" });
  const after = getPerson(db, personId).details;
  assert.equal(after.phone, "+34 600 000 001");
  assert.deepEqual(after.links, RICH.links);
  assert.deepEqual(after.employment, RICH.employment);
  assert.deepEqual(after.education, RICH.education);
});

test("R2: reordering employment moves ids with their entries; inserting and removing keeps the rest identical", () => {
  const { db, personId } = setup();
  const reversed = [RICH.employment[1], RICH.employment[0]];
  updatePersonDetails(db, personId, { employment: reversed });
  let after = getPerson(db, personId).details;
  assert.deepEqual(after.employment.map((e) => e.id), ["employment-beta", "employment-alpha"]);
  assert.equal(after.employment[0].employer, "Beta Corp", "the id travelled with its entry");
  assert.equal(after.employment[0].current, true, "the explicit current flag travelled with its entry");
  assert.deepEqual(after.employment[1], RICH.employment[0]);
  // Insert a new entry: the old ones keep ids and content.
  updatePersonDetails(db, personId, { employment: [...after.employment, { id: "employment-gamma", employer: "Gamma Corp", title: "Lead", start: "2024-01" }] });
  after = getPerson(db, personId).details;
  assert.deepEqual(after.employment.map((e) => e.id), ["employment-beta", "employment-alpha", "employment-gamma"]);
  // Remove one entry explicitly: the rest is untouched.
  updatePersonDetails(db, personId, { employment: [{ id: "employment-beta", deleted: true }] });
  after = getPerson(db, personId).details;
  assert.deepEqual(after.employment.map((e) => e.id), ["employment-alpha", "employment-gamma"]);
  assert.deepEqual(after.employment[0], RICH.employment[0]);
});

test("R2: editing one entry by id merges fields instead of replacing the entry", () => {
  const { db, personId } = setup();
  updatePersonDetails(db, personId, { employment: [{ id: "employment-alpha", title: "Senior Analyst" }] });
  const entry = getPerson(db, personId).details.employment.find((e) => e.id === "employment-alpha");
  assert.equal(entry.title, "Senior Analyst");
  assert.equal(entry.employer, "Alpha Corp");
  assert.deepEqual(entry.links, RICH.employment[0].links);
  assert.deepEqual(entry.achievements, ["Synthetic achievement"]);
});

test("R2: merge rejects unknown fields and still validates the result", () => {
  const { db, personId } = setup();
  assert.throws(() => mergePersonDetails(RICH, { unknown_field: true }), /unknown person field/);
  assert.throws(() => updatePersonDetails(db, personId, { full_name: "" }), /full_name is required/);
  assert.throws(() => updatePersonDetails(db, personId, { employment: [{ employer: "No Id Corp", title: "X" }] }), /needs an id/);
});
