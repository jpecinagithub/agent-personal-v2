// R1 (G2 re-review): CV proposals are immutable per import. Two
// discrepant CVs open at once must never mix: confirming one confirms
// only its own proposals, in either order, and a pre-existing confirmed
// fact is never overwritten without an explicit decision. Synthetic
// fixtures only (plain-text buffers, no files needed).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import { previewCv, confirmCvImport, rejectCvImport, getCvImport, correctProposal } from "../packages/shared/cv.mjs";
import { declareFact, getConfirmedFact } from "../packages/shared/facts.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-cvprop-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, FIXTURE_PERSON);
  return { db, personId };
}

const TXT_A = Buffer.from("Alpha Person\nalpha@example.test\n+34 600 111 111\n", "utf8");
const TXT_B = Buffer.from("Beta Person\nbeta@example.test\n+34 600 222 222\n", "utf8");

test("R1: reject B then confirm A confirms only A's email", async () => {
  const { db, personId } = setup();
  const a = await previewCv(db, personId, "a.txt", TXT_A);
  const b = await previewCv(db, personId, "b.txt", TXT_B);
  rejectCvImport(db, b.id);
  const result = confirmCvImport(db, a.id);
  assert.equal(result.status, "confirmed");
  assert.equal(getConfirmedFact(db, personId, "email", "").value, "alpha@example.test");
  assert.equal(getCvImport(db, b.id).status, "rejected");
  assert.ok(getCvImport(db, b.id).proposals.every((p) => p.status === "rejected"), "rejected proposals never apply");
});

test("R1: confirm B then reject A confirms only B's email (other order)", async () => {
  const { db, personId } = setup();
  const a = await previewCv(db, personId, "a.txt", TXT_A);
  const b = await previewCv(db, personId, "b.txt", TXT_B);
  confirmCvImport(db, b.id);
  rejectCvImport(db, a.id);
  assert.equal(getConfirmedFact(db, personId, "email", "").value, "beta@example.test");
});

test("R1: confirming a second discrepant CV conflicts instead of overwriting", async () => {
  const { db, personId } = setup();
  const a = await previewCv(db, personId, "a.txt", TXT_A);
  const b = await previewCv(db, personId, "b.txt", TXT_B);
  confirmCvImport(db, a.id);
  const result = confirmCvImport(db, b.id);
  assert.equal(result.status, "confirmed_with_conflicts");
  assert.ok(result.conflicts.some((c) => c.concept === "email" && c.existing === "alpha@example.test" && c.proposed === "beta@example.test"));
  assert.equal(getConfirmedFact(db, personId, "email", "").value, "alpha@example.test", "conflict must not overwrite the confirmed fact");
  // Explicit decision: keep leaves alpha; replace moves to beta.
  const kept = confirmCvImport(db, b.id, { resolutions: Object.fromEntries(result.conflicts.map((c) => [c.proposalId, "keep"])) });
  assert.equal(kept.status, "confirmed");
  assert.equal(getConfirmedFact(db, personId, "email", "").value, "alpha@example.test");
});

test("R1: a pre-existing confirmed fact is not overwritten without an explicit decision", async () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "email", scope: "", value: "existing@example.test", provenance: "user" });
  const a = await previewCv(db, personId, "a.txt", TXT_A);
  const result = confirmCvImport(db, a.id);
  assert.equal(result.status, "confirmed_with_conflicts");
  assert.equal(getConfirmedFact(db, personId, "email", "").value, "existing@example.test");
  const replaced = confirmCvImport(db, a.id, { resolutions: Object.fromEntries(result.conflicts.map((c) => [c.proposalId, "replace"])) });
  assert.equal(replaced.status, "confirmed");
  assert.equal(getConfirmedFact(db, personId, "email", "").value, "alpha@example.test", "an explicit replace decision applies");
});

test("R1: proposals can be corrected before confirming, and only that import's data applies", async () => {
  const { db, personId } = setup();
  const a = await previewCv(db, personId, "a.txt", TXT_A);
  const emailProposal = getCvImport(db, a.id).proposals.find((p) => p.concept === "email");
  assert.ok(emailProposal.source_document === "a.txt" && emailProposal.source_section && emailProposal.confidence > 0, "proposals carry document, section and confidence");
  correctProposal(db, emailProposal.id, "corrected@example.test");
  confirmCvImport(db, a.id);
  assert.equal(getConfirmedFact(db, personId, "email", "").value, "corrected@example.test");
  assert.throws(() => correctProposal(db, emailProposal.id, "too-late@example.test"), /only proposals of a previewed CV/, "correction after confirmation is refused");
});
