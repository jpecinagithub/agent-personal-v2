// G5 round-5 bypass fixes (user reproductions on 2d89c4b, 2026-10-30).
// Common cause: validation depended on particular textual forms or
// on the TYPE of reference, instead of universally validating the
// full content of every claim. Checks below are therefore triggered
// by CLAIM CONTENT, never by ref kind or exact textual shape.
// Synthetic fixtures only; no network, no submissions.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { createProfileFull } from "../packages/shared/profiles.mjs";
import { declareFact } from "../packages/shared/facts.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import {
  buildResumeContent, buildCoverLetterContent, createDocument,
  editDocument, prepareAttachment, auditDocumentVersion, revalidateContent,
} from "../packages/shared/documents.mjs";

function setup(personOverride = {}, profileBody = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-g5r5-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, { ...FIXTURE_PERSON, phone: "+34 600 123 456", ...personOverride });
  const profileId = createProfileFull(db, personId, "Finance", {
    desired_roles: ["Accountant"], skills: ["SAP", "Excel"], locations: ["Logroño, Spain"], ...profileBody,
  });
  return { db, personId, profileId };
}

function makeDoc(setupOut, content) {
  return createDocument(setupOut.db, { personId: setupOut.personId, profileId: setupOut.profileId, kind: "resume", content, gaps: content.gaps ?? [] });
}

function edited(setupOut, docId, content) {
  const result = editDocument(setupOut.db, docId, content);
  const audit = auditDocumentVersion(setupOut.db, setupOut.personId, setupOut.profileId, content);
  return { result, audit };
}

function expectBlocked(setupOut, docId, content) {
  const { result, audit } = edited(setupOut, docId, content);
  assert.equal(result.status, "needs_resolution", `expected needs_resolution, got ${result.status}: ${result.conflicts.join("; ")}`);
  assert.ok(audit.contamination > 0, "audit must count the invented claim as contamination");
  assert.throws(() => prepareAttachment(setupOut.db, { documentId: docId, version: result.version, format: "docx", role: "resume" }), "a needs_resolution version must never be preparable");
}

function addLine(content, heading, lineText, refs) {
  const next = JSON.parse(JSON.stringify(content));
  let sec = next.sections.find((s) => s.heading === heading);
  if (!sec) { sec = { heading, lines: [] }; next.sections.push(sec); }
  sec.lines.push({ text: lineText, refs });
  return next;
}

// --- Bypass 1: nominal award forms ------------------------------------

test("G5R5-1: nominal award 'Winner of the Nobel Prize' with an authorisation ref fails; with an award fact it validates", () => {
  const s = setup();
  const authId = declareFact(s.db, { personId: s.personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  expectBlocked(s, doc.documentId, addLine(content, "Awards", "Winner of the Nobel Prize", [{ kind: "fact", id: authId }]));
  expectBlocked(s, doc.documentId, addLine(content, "Awards", "Nobel Prize winner", [{ kind: "fact", id: authId }]));
  expectBlocked(s, doc.documentId, addLine(content, "Awards", "Recipient of the Nobel Prize", [{ kind: "fact", id: authId }]));
  const awardId = declareFact(s.db, { personId: s.personId, concept: "award", value: "Nobel Prize", provenance: "user" });
  const { result } = edited(s, doc.documentId, addLine(content, "Awards", "Winner of the Nobel Prize", [{ kind: "fact", id: awardId }]));
  assert.equal(result.status, "validated", result.conflicts.join("; "));
});

// --- Bypass 2: title check is content-triggered, not ref-kind-gated ---

test("G5R5-2: 'Chief Executive Officer' with only an authorisation ref fails; held content still validates", () => {
  const s = setup();
  const authId = declareFact(s.db, { personId: s.personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Chief Executive Officer", [{ kind: "fact", id: authId }]));
  // SUPERSEDED in round 6 by the user's decision (F5 original scope):
  // held content alone is never enough — every claim needs at least
  // one reference that REALLY backs it. "Accountant" with only an
  // authorisation ref is now a conflict, however true the phrase is.
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Accountant", [{ kind: "fact", id: authId }]));
  const { result } = edited(s, doc.documentId, addLine(content, "Skills", "Accountant", [{ kind: "profile", field: "desired_roles", value: ["Accountant"] }]));
  assert.equal(result.status, "validated", result.conflicts.join("; "));
});

// --- Bypass 3: space-form skill qualifiers -----------------------------

test("G5R5-3: 'Excel expert' and 'advanced Excel' fail with only 'Excel' held; an exactly held qualified skill validates", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const skillsRef = [{ kind: "profile", field: "skills", value: ["SAP", "Excel"] }];
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Excel expert", skillsRef));
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "advanced Excel", skillsRef));
  const { result } = edited(s, doc.documentId, addLine(content, "Skills", "Excel", skillsRef));
  assert.equal(result.status, "validated", result.conflicts.join("; "));
  const s2 = setup({}, { skills: ["SAP", "Excel expert"] });
  const content2 = buildResumeContent(s2.db, s2.personId, s2.profileId, {});
  const doc2 = makeDoc(s2, content2);
  const { result: r2 } = edited(s2, doc2.documentId, addLine(content2, "Skills", "Excel expert", [{ kind: "profile", field: "skills", value: ["SAP", "Excel expert"] }]));
  assert.equal(r2.status, "validated", r2.conflicts.join("; "));
});

// --- Bypass 4: bare and grouped phones ---------------------------------

test("G5R5-4: bare and grouped non-held phones fail; held phone in any separator style validates", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const phoneRef = [{ kind: "person", field: "phone", value: "+34 600 123 456" }];
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "5551234567", phoneRef));
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "555 123 456", phoneRef));
  for (const good of ["+34 600 123 456", "600 123 456", "600123456"]) {
    const { result } = edited(s, doc.documentId, addLine(content, "Skills", good, phoneRef));
    assert.equal(result.status, "validated", `${good}: ${result.conflicts.join("; ")}`);
  }
  // Disambiguation: a bare digit run that exactly equals a held
  // quantity value is that quantity, not a phone.
  const amountId = declareFact(s.db, { personId: s.personId, concept: "budget_managed", value: { amount: 100000000, currency: "USD" }, provenance: "user" });
  const { result } = edited(s, doc.documentId, addLine(content, "Skills", "100000000", [{ kind: "fact", id: amountId }]));
  assert.equal(result.status, "validated", result.conflicts.join("; "));
});

// --- Controls: generated documents still validate ----------------------

test("G5R5-ctrl: generated resume and cover letter still validate", () => {
  const s = setup();
  const resume = buildResumeContent(s.db, s.personId, s.profileId, {});
  const checkResume = revalidateContent(s.db, s.personId, s.profileId, resume);
  assert.equal(checkResume.ok, true, checkResume.conflicts.join("; "));
  const letter = buildCoverLetterContent(s.db, s.personId, s.profileId, { company: "Acme", role: "Accountant" });
  const checkLetter = revalidateContent(s.db, s.personId, s.profileId, letter);
  assert.equal(checkLetter.ok, true, checkLetter.conflicts.join("; "));
});
