// T-V2-015: Person entity. All fixture data is synthetic ("Test Person").
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull, updatePersonDetails, getPerson, validatePersonDetails } from "../packages/shared/person.mjs";
import { validateProfileBody } from "../packages/shared/profiles.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-person-"));
  return openDatabase(path.join(dir, "agentv2.db"));
}

test("a valid person is created with all declared fields, and can be edited", () => {
  const db = tmpDb();
  const id = createPersonFull(db, FIXTURE_PERSON);
  const person = getPerson(db, id);
  assert.equal(person.details.full_name, "Test Person");
  assert.equal(person.details.languages[0].language, "English");
  assert.equal(person.details.authorisations[0].country, "ES");
  assert.equal(person.details.employment[0].employer, "Fixture Corp");
  updatePersonDetails(db, id, { links: ["https://example.test/profile"] });
  assert.deepEqual(getPerson(db, id).details.links, ["https://example.test/profile"]);
});

test("unknown fields are rejected, never silently stored", () => {
  const db = tmpDb();
  assert.throws(() => createPersonFull(db, { ...FIXTURE_PERSON, invented_history: "x" }), /unknown person field: invented_history/);
  // Split 2026-10-29: search fields belong to profiles, not persons.
  assert.throws(() => validatePersonDetails({ ...FIXTURE_PERSON, salary_expectations: { currency: "EUR", min: 1 } }), /belongs to profiles, not to the person/);
  assert.throws(() => validateProfileBody({ salary_expectations: { currency: "EUR", bonus: 1 } }), /unknown salary_expectations field/);
});

test("required fields are validated, not defaulted or invented", () => {
  assert.throws(() => validatePersonDetails({ email: "a@example.test" }), /full_name is required/);
  assert.throws(() => validatePersonDetails({ full_name: "Test Person" }), /at least one contact method/);
  assert.throws(() => validatePersonDetails({ ...FIXTURE_PERSON, email: "not-an-email" }), /not a valid address/);
  assert.throws(() => validateProfileBody({ salary_expectations: { min: 70000, max: 50000 } }), /min must not exceed max/);
  assert.throws(() => validatePersonDetails({ ...FIXTURE_PERSON, employment: [{ id: "j", employer: "X", title: "Y", start: "Jan 2020" }] }), /start must be YYYY/);
  assert.throws(() => validatePersonDetails({ ...FIXTURE_PERSON, languages: [{ language: "English" }] }), /language and a level/);
});
