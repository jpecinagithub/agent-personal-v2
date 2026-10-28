// Regression net for the five checks the user's G2 re-review verified
// as CORRECT (review-results.json, passed: true). These behaviours must
// stay green while R1..R6 are fixed; they are not to be reopened.
import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull, updatePersonDetails, getPerson } from "../packages/shared/person.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import { createProfileFull, listProfiles, archiveProfile, deleteProfile, profileReadiness, createAttempt, getAttempt } from "../packages/shared/profiles.mjs";
import { previewCv, confirmCvImport } from "../packages/shared/cv.mjs";
import { acceptPolicy, giveConsent } from "../packages/shared/policies.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-positive-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, FIXTURE_PERSON);
  return { db, personId };
}

function offer(db, id) {
  db.prepare("INSERT INTO offers (id, source, ats, canonical_url, title) VALUES (?, 'greenhouse', 'greenhouse', ?, 'Finance Manager')").run(id, `https://example.test/jobs/${id}`);
  return id;
}

test("positive: archiving one of ten profiles does not free a slot", () => {
  const { db, personId } = setup();
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(createProfileFull(db, personId, `P${i}`, { focus: "Finance" }));
  archiveProfile(db, ids[0]);
  assert.throws(() => createProfileFull(db, personId, "P11", { focus: "Finance" }), /at most 10 non-deleted profiles/);
});

test("positive: the person snapshot stays unchanged after identity and history edits", async () => {
  const { db, personId } = setup();
  const txt = fs.readFileSync(fileURLToPath(new URL("./fixtures/sample.txt", import.meta.url)));
  const preview = await previewCv(db, personId, "sample.txt", txt);
  confirmCvImport(db, preview.id);
  acceptPolicy(db, personId, "data_processing");
  giveConsent(db, personId, "apply_on_behalf");
  const profileId = createProfileFull(db, personId, "Finance", { focus: "Finance", cv_import_id: preview.id });
  const attemptId = createAttempt(db, personId, profileId, offer(db, "offer-pos-1"), { xaiVerified: true });
  updatePersonDetails(db, personId, { full_name: "Renamed Person", email: "renamed@example.test", employment: [{ id: "job-9", employer: "Other Corp", title: "Controller", start: "2024-07" }] });
  const kept = getAttempt(db, attemptId).personSnapshot;
  assert.equal(kept.full_name, "Test Person");
  assert.equal(kept.email, "test.person@example.test");
  assert.equal(kept.employment[0].employer, "Fixture Corp");
  assert.equal(getPerson(db, personId).details.full_name, "Renamed Person");
});

test("positive: soft deletion retains the previous attempt and frees exactly one slot", async () => {
  const { db, personId } = setup();
  const txt = fs.readFileSync(fileURLToPath(new URL("./fixtures/sample.txt", import.meta.url)));
  const preview = await previewCv(db, personId, "sample.txt", txt);
  confirmCvImport(db, preview.id);
  acceptPolicy(db, personId, "data_processing");
  giveConsent(db, personId, "apply_on_behalf");
  const ids = [];
  for (let i = 0; i < 10; i++) ids.push(createProfileFull(db, personId, `P${i}`, { focus: "Finance", cv_import_id: preview.id }));
  const attemptId = createAttempt(db, personId, ids[0], offer(db, "offer-pos-2"), { xaiVerified: true });
  archiveProfile(db, ids[0]);
  deleteProfile(db, ids[0]);
  assert.equal(listProfiles(db, personId).length, 9, "soft deletion frees exactly one slot");
  const kept = getAttempt(db, attemptId);
  assert.ok(kept && kept.personSnapshot, "the previous attempt and its snapshot survive soft deletion");
  assert.equal(kept.personSnapshot.full_name, "Test Person");
});

test("positive: missing xAI blocks readiness initially", () => {
  const { db, personId } = setup();
  const profileId = createProfileFull(db, personId, "Finance", { focus: "Finance" });
  const r = profileReadiness(db, profileId);
  assert.equal(r.ready, false);
  assert.ok(r.missing.includes("xai"), "with no verification at all, xai must block");
});
