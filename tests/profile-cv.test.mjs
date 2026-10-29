// R4 (G2 re-review): a validated CV belongs to a profile only when
// explicitly selected for it. One profile's CV never enables another
// profile, the same CV may be reused across profiles, and the attempt
// snapshot pins the chosen CV version. Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import { createProfileFull, profileReadiness, createAttempt, getAttempt } from "../packages/shared/profiles.mjs";
import { createDraft, updateDraft, confirmDraft } from "../packages/shared/drafts.mjs";
import { previewCv, confirmCvImport } from "../packages/shared/cv.mjs";
import { acceptPolicy, giveConsent } from "../packages/shared/policies.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-profilecv-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, FIXTURE_PERSON);
  acceptPolicy(db, personId, "data_processing");
  giveConsent(db, personId, "apply_on_behalf");
  return { db, personId };
}

function offer(db, id) {
  db.prepare("INSERT INTO offers (id, source, ats, canonical_url, title) VALUES (?, 'greenhouse', 'greenhouse', ?, 'Finance Manager')").run(id, `https://example.test/jobs/${id}`);
  return id;
}

async function confirmedCv(db, personId, filename, text) {
  const preview = await previewCv(db, personId, filename, Buffer.from(text, "utf8"));
  confirmCvImport(db, preview.id);
  return preview.id;
}

test("R4: a new profile without an assigned CV stays incomplete even when another profile has one", async () => {
  const { db, personId } = setup();
  const cvId = await confirmedCv(db, personId, "first.txt", "First Person\nfirst@example.test\n");
  const withCv = createProfileFull(db, personId, "With CV", { cv_import_id: cvId });
  assert.ok(!profileReadiness(db, withCv, { xaiVerified: true }).missing.includes("cv_validated"), "the profile that selected the CV clears cv_validated");
  const withoutCv = createProfileFull(db, personId, "Without CV", {});
  const r = profileReadiness(db, withoutCv, { xaiVerified: true });
  assert.ok(r.missing.includes("cv_validated"), "a profile without a selected CV must still need one");
  assert.equal(r.ready, false);
});

test("R4: assigning an unconfirmed CV is rejected; assigning a valid one resolves; reuse across profiles is allowed", async () => {
  const { db, personId } = setup();
  const preview = await previewCv(db, personId, "pending.txt", Buffer.from("Pending Person\npending@example.test\n", "utf8"));
  assert.throws(
    () => createProfileFull(db, personId, "Too Early", { cv_import_id: preview.id }),
    /must be a confirmed CV/,
    "a previewed, unconfirmed CV cannot be assigned",
  );
  const cvId = await confirmedCv(db, personId, "valid.txt", "Valid Person\nvalid@example.test\n");
  const p1 = createProfileFull(db, personId, "One", { cv_import_id: cvId });
  const p2 = createProfileFull(db, personId, "Two", { cv_import_id: cvId });
  assert.ok(!profileReadiness(db, p1, { xaiVerified: true }).missing.includes("cv_validated"));
  assert.ok(!profileReadiness(db, p2, { xaiVerified: true }).missing.includes("cv_validated"), "the same CV may be reused across profiles");
});

test("R4: changing a profile's CV does not alter historical attempts; new attempts pin the new version", async () => {
  const { db, personId } = setup();
  const cvA = await confirmedCv(db, personId, "a.txt", "Alpha Person\nalpha@example.test\n");
  // CV B conflicts with A's confirmed facts, so it lands in
  // confirmed_with_conflicts: under the G2 re-review 2 rule it may be
  // selected, but it cannot enter an attempt until its conflicts are
  // resolved explicitly.
  const previewB = await previewCv(db, personId, "b.txt", Buffer.from("Beta Person\nbeta@example.test\n", "utf8"));
  const conflictResult = confirmCvImport(db, previewB.id);
  assert.equal(conflictResult.status, "confirmed_with_conflicts");
  const cvB = previewB.id;
  const profileId = createProfileFull(db, personId, "Finance", { cv_import_id: cvA });
  const first = createAttempt(db, personId, profileId, offer(db, "offer-r4-1"), { xaiVerified: true });
  assert.equal(getAttempt(db, first).cvSnapshot.filename, "a.txt");
  assert.equal(getAttempt(db, first).cvSnapshot.extracted_text.includes("alpha@example.test"), true);
  // Change the CV through a draft (the versioned change path).
  const draftId = createDraft(db, profileId);
  const body = JSON.parse(String(db.prepare("SELECT body_json FROM profiles WHERE id = ?").get(profileId).body_json));
  updateDraft(db, draftId, { ...body, cv_import_id: cvB });
  confirmDraft(db, draftId);
  assert.throws(
    () => createAttempt(db, personId, profileId, offer(db, "offer-r4-2"), { xaiVerified: true }),
    /cv_conflicts_unresolved/,
    "the unresolved conflicted CV must not enter an attempt",
  );
  // Resolve every conflict explicitly (keep the confirmed facts), then
  // the new attempt pins the new CV version.
  const resolutions = {};
  for (const c of conflictResult.conflicts) resolutions[c.proposalId] = "keep";
  assert.equal(confirmCvImport(db, cvB, { resolutions }).status, "confirmed");
  // Fresh offer: the rejected attempt above already inserted the
  // offer-r4-2 row (the helper inserts before attempting), and offers
  // are unique by canonical URL.
  const second = createAttempt(db, personId, profileId, offer(db, "offer-r4-3"), { xaiVerified: true });
  assert.equal(getAttempt(db, second).cvSnapshot.filename, "b.txt");
  assert.equal(getAttempt(db, first).cvSnapshot.filename, "a.txt", "the historical attempt keeps its original CV version");
  assert.equal(getAttempt(db, first).cvSnapshot.extracted_text.includes("alpha@example.test"), true);
});
