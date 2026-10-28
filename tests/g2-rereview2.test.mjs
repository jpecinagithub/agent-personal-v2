// G2 re-review 2 (2026-10-28, review of f9726ef): three issues the
// user's independent checks found after the R1–R6 corrections.
// 1. A CV with unresolved conflicts must not enable readiness or an
//    attempt (only a fully confirmed CV validates).
// 2. The person form must distinguish an absent field from an
//    explicit deletion: unchecked "current" stores false, cleared
//    lists store [], and authorisation nested fields survive a save.
// 3. A rejected cross-import proposal correction must not modify the
//    other import: belonging is validated before any write.
// Synthetic fixtures only; no real data, no real xAI calls.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull, updatePersonDetails, getPerson } from "../packages/shared/person.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import { createProfileFull, profileReadiness, createAttempt } from "../packages/shared/profiles.mjs";
import { previewCv, confirmCvImport, getCvImport, listProposals, correctProposal } from "../packages/shared/cv.mjs";
import { acceptPolicy, giveConsent } from "../packages/shared/policies.mjs";
import { createServer } from "../apps/server/server.mjs";

function setupPerson(db) {
  const personId = createPersonFull(db, FIXTURE_PERSON);
  acceptPolicy(db, personId, "data_processing");
  giveConsent(db, personId, "apply_on_behalf");
  return personId;
}

function tmpDb(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, db: openDatabase(path.join(dir, "agentv2.db")) };
}

async function conflictedSetup() {
  const { db } = tmpDb("agentv2-rereview2-");
  const personId = setupPerson(db);
  const first = await previewCv(db, personId, "first.txt", Buffer.from("First Person\nsynthetic@example.test\n", "utf8"));
  confirmCvImport(db, first.id);
  const second = await previewCv(db, personId, "second.txt", Buffer.from("Second Person\nconflicting@example.test\n", "utf8"));
  const result = confirmCvImport(db, second.id);
  assert.equal(result.status, "confirmed_with_conflicts", "the second CV must land in confirmed_with_conflicts");
  assert.equal(getCvImport(db, first.id).status, "confirmed");
  return { db, personId, firstId: first.id, secondId: second.id, result };
}

test("An unresolved CV conflict blocks readiness", async () => {
  const { db, personId, secondId } = await conflictedSetup();
  const profileId = createProfileFull(db, personId, "Conflicted CV", { focus: "Finance", cv_import_id: secondId });
  const r = profileReadiness(db, profileId, { xaiVerified: true });
  assert.equal(r.ready, false, "a profile whose CV has unresolved conflicts is not ready");
  assert.ok(r.missing.includes("cv_conflicts_unresolved"), `the reason must name the unresolved conflicts, got: ${r.missing.join(", ")}`);
});

test("An unresolved CV conflict cannot enter an attempt", async () => {
  const { db, personId, secondId } = await conflictedSetup();
  const profileId = createProfileFull(db, personId, "Conflicted CV", { focus: "Finance", cv_import_id: secondId });
  const attemptsBefore = db.prepare("SELECT COUNT(*) AS n FROM attempts").get().n;
  const snapshotsBefore = db.prepare("SELECT COUNT(*) AS n FROM person_snapshots").get().n;
  // A fresh synthetic offer: reusing an offer id must not mask the
  // readiness failure behind a deduplication error.
  assert.throws(
    () => createAttempt(db, personId, profileId, "offer-rereview2-fresh", { xaiVerified: true }),
    /cv_conflicts_unresolved|not ready/,
    "attempt creation must be rejected before any snapshot or row",
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get().n, attemptsBefore, "no attempt row may be created");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person_snapshots").get().n, snapshotsBefore, "no person snapshot may be created");
});

test("Resolving the conflict explicitly unlocks readiness", async () => {
  const { db, personId, secondId, result } = await conflictedSetup();
  // The second CV conflicts on every concept the first CV already
  // confirmed (email and full name here); all of them must be
  // resolved before the import counts as validated.
  const resolutions = {};
  for (const conflict of result.conflicts) resolutions[conflict.proposalId] = "keep";
  assert.ok(result.conflicts.length >= 1);
  const resolved = confirmCvImport(db, secondId, { resolutions });
  assert.equal(resolved.status, "confirmed", "keeping the confirmed fact resolves the import");
  const profileId = createProfileFull(db, personId, "Resolved CV", { focus: "Finance", cv_import_id: secondId });
  const r = profileReadiness(db, profileId, { xaiVerified: true });
  assert.ok(!r.missing.includes("cv_conflicts_unresolved"), "no conflict reason may remain after resolution");
  assert.ok(!r.missing.includes("cv_validated"), "the resolved CV now validates");
});

test("Rejected cross-import correction does not modify the other CV", async () => {
  const { db } = tmpDb("agentv2-rereview2-x-");
  const personId = setupPerson(db);
  const a = await previewCv(db, personId, "a.txt", Buffer.from("Person A\nalpha@example.test\n", "utf8"));
  const b = await previewCv(db, personId, "b.txt", Buffer.from("Person B\nbeta@example.test\n", "utf8"));
  const proposalB = listProposals(db, b.id).find((p) => p.concept === "email");
  const beforeB = JSON.stringify(listProposals(db, b.id));
  const beforeA = JSON.stringify(listProposals(db, a.id));
  assert.throws(
    () => correctProposal(db, proposalB.id, "changed@example.test", a.id),
    /does not belong to this CV import/,
    "correcting B's proposal through A's id must be rejected",
  );
  assert.equal(JSON.stringify(listProposals(db, b.id)), beforeB, "B's proposals must be byte-identical after the rejected correction");
  assert.equal(JSON.stringify(listProposals(db, a.id)), beforeA, "A's proposals must be untouched too");
});

test("Rejected cross-import correction over HTTP leaves both imports intact", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-rereview2-http-"));
  const { server } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const person = await (await fetch(`${base}/api/person`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(FIXTURE_PERSON) })).json();
    const personId = person.id;
    const upload = async (filename, text) => (await (await fetch(`${base}/api/cv`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ personId, filename, contentBase64: Buffer.from(text, "utf8").toString("base64") }) })).json());
    const a = await upload("a.txt", "Person A\nalpha@example.test\n");
    const b = await upload("b.txt", "Person B\nbeta@example.test\n");
    const bBefore = await (await fetch(`${base}/api/cv/${b.id}`)).json();
    const proposalB = bBefore.cv.proposals.find((p) => p.concept === "email");
    const r = await fetch(`${base}/api/cv/${a.id}/proposals/${proposalB.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: "changed@example.test" }) });
    assert.equal(r.status, 400, "the cross-import correction must be rejected over HTTP");
    const bAfter = await (await fetch(`${base}/api/cv/${b.id}`)).json();
    assert.deepEqual(bAfter.cv.proposals, bBefore.cv.proposals, "B's proposals must be identical after the rejected HTTP correction");
  } finally {
    server.close();
  }
});

const RICH_AUTH = {
  full_name: "Synthetic Original",
  email: "original@example.test",
  phone: "+34 600 000 001",
  links: ["https://example.test/professional-profile"],
  authorisations: [
    { id: "auth-1", country: "ES", status: "authorised", valid_until: "2030-12", sponsorship_required: true },
  ],
  employment: [
    { id: "employment-beta", employer: "Beta Corp", title: "Senior Analyst", start: "2022-02", current: true },
  ],
};

test("Form edits: unchecking current stores false and saves the end date", () => {
  const { db } = tmpDb("agentv2-rereview2-form-");
  const personId = createPersonFull(db, RICH_AUTH);
  updatePersonDetails(db, personId, { employment: [{ id: "employment-beta", current: false, end: "2024-06" }] });
  const entry = getPerson(db, personId).details.employment[0];
  assert.equal(entry.current, false, "an explicitly unchecked current flag must be stored as false");
  assert.equal(entry.end, "2024-06", "the entered end date must be saved alongside it");
});

test("Form edits: clearing a list stores an empty list, not the old one", () => {
  const { db } = tmpDb("agentv2-rereview2-form-");
  const personId = createPersonFull(db, RICH_AUTH);
  updatePersonDetails(db, personId, { links: [] });
  assert.deepEqual(getPerson(db, personId).details.links, [], "an explicitly cleared list must be empty after save");
  // And clearing must not touch anything else.
  assert.equal(getPerson(db, personId).details.employment[0].current, true);
});

test("Form edits: authorisation nested fields survive a partial save and clear explicitly", () => {
  const { db } = tmpDb("agentv2-rereview2-form-");
  const personId = createPersonFull(db, RICH_AUTH);
  updatePersonDetails(db, personId, { authorisations: [{ id: "auth-1", country: "ES", status: "authorised" }] });
  let auth = getPerson(db, personId).details.authorisations[0];
  assert.equal(auth.valid_until, "2030-12", "an unedited nested field must survive a partial authorisation save");
  assert.equal(auth.sponsorship_required, true, "an unedited sponsorship flag must survive");
  updatePersonDetails(db, personId, { authorisations: [{ id: "auth-1", valid_until: null, sponsorship_required: false }] });
  auth = getPerson(db, personId).details.authorisations[0];
  assert.equal(auth.valid_until, undefined, "an explicitly cleared valid_until must be gone");
  assert.equal(auth.sponsorship_required, false, "an explicitly unchecked sponsorship flag must be false");
  assert.equal(auth.country, "ES", "the rest of the authorisation must be untouched");
});

test("Form edits: an explicit null clears a scalar, absence preserves it", () => {
  const { db } = tmpDb("agentv2-rereview2-form-");
  const personId = createPersonFull(db, RICH_AUTH);
  updatePersonDetails(db, personId, { email: null });
  const details = getPerson(db, personId).details;
  assert.equal(details.email, undefined, "an explicitly cleared email must be gone");
  assert.equal(details.phone, "+34 600 000 001", "the other contact method must survive");
  updatePersonDetails(db, personId, { availability: "immediate" });
  assert.equal(getPerson(db, personId).details.email, undefined, "an absent field in a later patch must stay cleared, not resurrect");
});

test("Form edits: an id-less stored authorisation merges by country instead of duplicating", () => {
  const { db } = tmpDb("agentv2-rereview2-form-");
  const personId = createPersonFull(db, {
    full_name: "Synthetic Original",
    email: "original@example.test",
    authorisations: [{ country: "ES", status: "authorised" }],
  });
  updatePersonDetails(db, personId, { authorisations: [{ country: "ES", status: "authorised", valid_until: "2031-01" }] });
  const auths = getPerson(db, personId).details.authorisations;
  assert.equal(auths.length, 1, "the legacy entry must be updated in place, not duplicated");
  assert.equal(auths[0].valid_until, "2031-01");
  assert.ok(auths[0].id, "the merged entry gains a stable id for later saves");
});
