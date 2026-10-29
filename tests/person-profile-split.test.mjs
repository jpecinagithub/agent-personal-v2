// User-approved split 2026-10-29 (mutually exclusive person/profile
// fields). Synthetic data only; no attempts, no submissions.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull, updatePersonDetails, getPerson, validatePersonDetails } from "../packages/shared/person.mjs";
import { createProfileFull, getProfileFull, listProfiles } from "../packages/shared/profiles.mjs";
import { buildProfileView } from "../packages/shared/search-run.mjs";
import { migrateLegacyPersonSearchFields } from "../packages/shared/person-search-migration.mjs";
import { createServer } from "../apps/server/server.mjs";

const PERSON_ONLY = {
  full_name: "Test Person",
  email: "test.person@example.test",
  languages: [{ language: "English", level: "C1" }],
  authorisations: [{ country: "ES", status: "authorised", sponsorship_required: false }],
  mobility: "spain",
  employment: [{ id: "job-1", employer: "Fixture Corp", title: "Accountant", start: "2020-01" }],
  education: [{ id: "edu-1", institution: "Fixture University", title: "BSc Test Studies", start: "2016", end: "2020" }],
};

const SEARCH_KEYS = ["desired_roles", "locations", "skills", "exclusions", "salary_expectations"];

function setup(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return openDatabase(path.join(dir, "agentv2.db"));
}

// Raw legacy row, bypassing person validation (which now rejects
// these keys): this is what an existing database from before the
// split looks like on disk.
function insertLegacyPerson(db, id, details) {
  db.prepare("INSERT INTO persons (id, display_name, contact_json, details_json) VALUES (?, ?, ?, ?)").run(
    id, details.full_name, JSON.stringify({ email: details.email ?? null, phone: null }), JSON.stringify(details),
  );
}

test("split: every search-preference key is rejected on the person, on create and on patch", () => {
  const db = setup("agentv2-split-");
  for (const key of SEARCH_KEYS) {
    const value = key === "salary_expectations" ? { currency: "EUR", min: 50000 } : ["x"];
    assert.throws(() => validatePersonDetails({ ...PERSON_ONLY, [key]: value }), /belongs to profiles, not to the person/);
    assert.throws(() => createPersonFull(db, { ...PERSON_ONLY, [key]: value }), /belongs to profiles, not to the person/);
  }
  const personId = createPersonFull(db, PERSON_ONLY);
  for (const key of SEARCH_KEYS) {
    assert.throws(() => updatePersonDetails(db, personId, { [key]: null }), /belongs to profiles, not to the person/);
    assert.throws(() => updatePersonDetails(db, personId, { [key]: key === "salary_expectations" ? { currency: "EUR" } : ["y"] }), /belongs to profiles, not to the person/);
  }
  assert.equal(getPerson(db, personId).details.desired_roles, undefined);
});

test("split: profile creation starts empty, and the profile view carries only profile fields plus personal circumstances", () => {
  const db = setup("agentv2-split-empty-");
  const personId = createPersonFull(db, PERSON_ONLY);
  const profileId = createProfileFull(db, personId, "Finance", {});
  const body = getProfileFull(db, profileId).body;
  for (const key of SEARCH_KEYS) assert.equal(body[key], undefined, `empty create stores no ${key}`);
  const view = buildProfileView(db, profileId);
  assert.deepEqual(view.fields.desired_roles, []);
  assert.deepEqual(view.fields.skills, []);
  // Deliberate exception, kept: personal circumstances (authorisation
  // + mobility) still feed criteria, edited only in Persona.
  assert.equal(view.mobility, "spain");
  assert.equal(view.authorisationByCountry.ES, "yes");
});

test("split: migration moves legacy fields to the first profile without overwriting its own values", () => {
  const db = setup("agentv2-split-mig-");
  insertLegacyPerson(db, "person-1", {
    ...PERSON_ONLY,
    desired_roles: ["Finance Manager"], locations: ["Madrid"], skills: ["accounting"],
    exclusions: ["night shifts"], salary_expectations: { currency: "EUR", min: 50000, max: 70000, period: "year" },
  });
  // First profile owns skills already; locations is empty; the rest absent.
  db.prepare("INSERT INTO profiles (id, person_id, name, template, body_json) VALUES (?, ?, ?, '', ?)").run(
    "profile-1", "person-1", "Existing", JSON.stringify({ skills: ["forecasting"], locations: [] }),
  );
  const result = migrateLegacyPersonSearchFields(db);
  assert.equal(result.personsMoved, 1);
  assert.equal(result.profilesCreated, 0);
  const profile = getProfileFull(db, "profile-1");
  assert.deepEqual(profile.body.desired_roles, ["Finance Manager"], "absent field moved in");
  assert.deepEqual(profile.body.locations, ["Madrid"], "empty field moved in");
  assert.deepEqual(profile.body.skills, ["forecasting"], "profile's own skills never overwritten");
  assert.deepEqual(profile.body.exclusions, ["night shifts"]);
  assert.deepEqual(profile.body.salary_expectations, { currency: "EUR", min: 50000, max: 70000, period: "year" });
  const person = getPerson(db, "person-1");
  for (const key of SEARCH_KEYS) assert.equal(person.details[key], undefined, `${key} deleted from person`);
  assert.equal(person.details.full_name, "Test Person", "person identity untouched");
  // Idempotent: a second run moves nothing and creates nothing.
  const again = migrateLegacyPersonSearchFields(db);
  assert.deepEqual(again, { personsMoved: 0, profilesCreated: 0 });
  assert.deepEqual(getProfileFull(db, "profile-1").body, profile.body);
});

test("split: migration creates a profile when none exists, named from the first desired role", () => {
  const db = setup("agentv2-split-mig2-");
  insertLegacyPerson(db, "person-2", {
    ...PERSON_ONLY,
    desired_roles: ["Finance Manager", "Controller"], locations: ["Logroño"],
    salary_expectations: { currency: "EUR", min: 60000, period: "year" },
  });
  const result = migrateLegacyPersonSearchFields(db);
  assert.equal(result.personsMoved, 1);
  assert.equal(result.profilesCreated, 1);
  const profiles = listProfiles(db, "person-2");
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, "Finance Manager", "named from first desired role");
  assert.deepEqual(profiles[0].body.desired_roles, ["Finance Manager", "Controller"]);
  assert.deepEqual(profiles[0].body.locations, ["Logroño"]);
  assert.equal(getPerson(db, "person-2").details.desired_roles, undefined);
});

test("split: migration without desired roles creates 'Perfil principal'", () => {
  const db = setup("agentv2-split-mig3-");
  insertLegacyPerson(db, "person-3", { ...PERSON_ONLY, skills: ["accounting"] });
  migrateLegacyPersonSearchFields(db);
  const profiles = listProfiles(db, "person-3");
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, "Perfil principal");
  assert.deepEqual(profiles[0].body.skills, ["accounting"]);
});

test("split: API rejects person search fields and lists entries for the top selector", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-split-api-"));
  const { server } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  try {
    const bad = await fetch(`${base}/api/person`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...PERSON_ONLY, desired_roles: ["Finance Manager"] }),
    });
    assert.equal(bad.status, 400, "person API rejects search fields");
    const ok = await fetch(`${base}/api/person`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PERSON_ONLY),
    });
    assert.equal(ok.status, 201);
    const personId = (await ok.json()).id;
    const prof = await fetch(`${base}/api/profiles`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personId, name: "Finance", body: { desired_roles: ["Finance Manager"] } }),
    });
    assert.equal(prof.status, 201);
    const entries = await (await fetch(`${base}/api/persons`)).json();
    assert.equal(entries.persons.length, 1);
    assert.equal(entries.persons[0].full_name, "Test Person");
    const byId = await fetch(`${base}/api/persons/${personId}`);
    assert.equal(byId.status, 200);
    assert.equal((await byId.json()).person.id, personId);
    const missing = await fetch(`${base}/api/persons/no-such-person`);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

test("split: stored authorisations and sponsorship facts still feed criteria after the person-form removal", () => {
  // User order 2026-10-29 removed authorisation/sponsorship editing
  // AND display from the Person screen (UI only). The backend data
  // and the criteria engine are untouched: a profile view built from
  // stored authorisations must still carry them into search criteria.
  const db = setup("agentv2-split-criteria-");
  const personId = createPersonFull(db, {
    ...PERSON_ONLY,
    authorisations: [
      { country: "ES", status: "authorised", sponsorship_required: false },
      { country: "FR", status: "authorised", sponsorship_required: true },
      { country: "DE", status: "pending", sponsorship_required: false },
    ],
  });
  const profileId = createProfileFull(db, personId, "Finance", {});
  const view = buildProfileView(db, profileId);
  assert.equal(view.authorisationByCountry.ES, "yes");
  assert.equal(view.authorisationByCountry.FR, "yes");
  assert.equal(view.authorisationByCountry.DE, "unknown", "unknown status is never inferred towards yes");
  assert.equal(view.sponsorshipRequiredByCountry.FR, true);
  assert.equal(view.sponsorshipRequiredByCountry.ES, false);
  assert.equal(view.sponsorshipRequired, true, "one sponsoring country makes sponsorship required");
  assert.equal(getPerson(db, personId).details.authorisations.length, 3, "stored authorisations untouched");
});

test("focus deleted: the API rejects focus in a profile body, and a profile without focus is never flagged for it", async () => {
  // User order 2026-10-29: the focus field is deleted entirely — UI,
  // database and readiness. The profile name alone identifies it.
  const db = setup("agentv2-nofocus-");
  const personId = createPersonFull(db, PERSON_ONLY);
  assert.throws(() => createProfileFull(db, personId, "Finance", { focus: "Finance" }), /unknown profile field: focus/);
  const profileId = createProfileFull(db, personId, "Finance", {});
  const { profileReadiness } = await import("../packages/shared/profiles.mjs");
  assert.ok(!profileReadiness(db, profileId).missing.includes("focus"), "focus must never block readiness");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-nofocus-api-"));
  const { server } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  try {
    const personRes = await fetch(`${base}/api/person`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(PERSON_ONLY),
    });
    assert.equal(personRes.status, 201);
    const apiPersonId = (await personRes.json()).id;
    const bad = await fetch(`${base}/api/profiles`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ personId: apiPersonId, name: "Finance", body: { focus: "Finance" } }),
    });
    assert.equal(bad.status, 400, "profile API rejects the deleted focus field");
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(!html.includes("profile-focus"), "served UI has no focus input");
    assert.ok(!html.includes("Enfoque"), "served UI has no focus label");
    assert.ok(!html.includes("sin enfoque"), "served UI has no focus display");
  } finally {
    server.close();
  }
});

test("focus deleted: migration 010 drops the column and strips body_json keys on an old database", async () => {
  // Simulate a pre-010 database: a fresh database (current schema has
  // no focus column) gains the old column and old body values back,
  // then reopening it — the real upgrade path, since
  // removeProfileFocus runs on every open — must clean both.
  const { DatabaseSync } = await import("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-nofocus-mig-"));
  const dbPath = path.join(dir, "agentv2.db");
  const db = openDatabase(dbPath);
  const personId = createPersonFull(db, PERSON_ONLY);
  const profileId = createProfileFull(db, personId, "Finance", { template: "finance", desired_roles: ["Finance Manager"] });
  db.close();
  const raw = new DatabaseSync(dbPath);
  raw.exec("ALTER TABLE profiles ADD COLUMN focus TEXT NOT NULL DEFAULT '';");
  raw.prepare("UPDATE profiles SET focus = 'Finance' WHERE id = ?").run(profileId);
  const row = raw.prepare("SELECT body_json FROM profiles WHERE id = ?").get(profileId);
  const body = JSON.parse(String(row.body_json));
  body.focus = "Finance";
  raw.prepare("UPDATE profiles SET body_json = ? WHERE id = ?").run(JSON.stringify(body), profileId);
  raw.close();
  const migrated = openDatabase(dbPath);
  const cols = migrated.prepare("PRAGMA table_info(profiles)").all().map((c) => c.name);
  assert.ok(!cols.includes("focus"), "focus column is gone after migration");
  const profile = getProfileFull(migrated, profileId);
  assert.equal(profile.body.focus, undefined, "focus key stripped from body_json");
  assert.equal(profile.name, "Finance", "profile identity intact");
  assert.equal(profile.body.template, "finance", "other body fields intact");
  assert.deepEqual(profile.body.desired_roles, ["Finance Manager"], "search fields intact");
  assert.ok(!("focus" in profile), "no focus column value leaks through the profile row");
  migrated.close();
});
