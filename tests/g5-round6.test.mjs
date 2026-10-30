// G5 round-6 blockers (user reproductions on cc99ec2, 2026-10-30).
// User decision, governing rule (F5 original scope, NOT an
// extension): EVERY claim must have at least one reference that
// REALLY backs it. Held content accompanied only by an unrelated
// confirmed reference is a conflict. Labels must never be a route
// around validation ("Position: X" is judged on X).
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-g5r6-"));
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
  assert.ok(audit.contamination > 0, "audit must count the invented/unbacked claim as contamination");
  assert.throws(() => prepareAttachment(setupOut.db, { documentId: docId, version: result.version, format: "docx", role: "resume" }), "a needs_resolution version must never be preparable");
}

function addLine(content, heading, lineText, refs) {
  const next = JSON.parse(JSON.stringify(content));
  let sec = next.sections.find((s) => s.heading === heading);
  if (!sec) { sec = { heading, lines: [] }; next.sections.push(sec); }
  sec.lines.push({ text: lineText, refs });
  return next;
}

function addSection(content, heading, lines, sectionRefs) {
  const next = JSON.parse(JSON.stringify(content));
  const sec = { heading, lines };
  if (sectionRefs !== undefined) sec.refs = sectionRefs;
  next.sections.push(sec);
  return next;
}

// --- Blocker 1: held content needs a supporting ref -------------------

test("G5R6-1: 'Accountant' with ONLY an authorisation ref fails; with a supporting ref it validates", () => {
  const s = setup();
  const authId = declareFact(s.db, { personId: s.personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Accountant", [{ kind: "fact", id: authId }]));
  // At least one supporting ref suffices, even with unrelated extras.
  const { result } = edited(s, doc.documentId, addLine(content, "Skills", "Accountant", [
    { kind: "fact", id: authId },
    { kind: "profile", field: "desired_roles", value: ["Accountant"] },
  ]));
  assert.equal(result.status, "validated", result.conflicts.join("; "));
  const { result: r2 } = edited(s, doc.documentId, addLine(content, "Skills", "Accountant", [
    { kind: "profile", field: "desired_roles", value: ["Accountant"] },
  ]));
  assert.equal(r2.status, "validated", r2.conflicts.join("; "));
});

test("G5R6-1b: a claim heading is blocked even when its section lines carry refs", () => {
  const s = setup();
  const authId = declareFact(s.db, { personId: s.personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  // Heading default-deny is independent of any refs attached anywhere.
  expectBlocked(s, doc.documentId, addSection(content, "Winner of the Nobel Prize", [
    { text: "Accountant", refs: [{ kind: "profile", field: "desired_roles", value: ["Accountant"] }] },
  ], [{ kind: "fact", id: authId }]));
});

// --- Blocker 2: "Position:" (and sibling labels) -----------------------

test("G5R6-2: 'Position: Chief Executive Officer' fails with only Accountant retained", () => {
  const s = setup();
  const authId = declareFact(s.db, { personId: s.personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Position: Chief Executive Officer", [{ kind: "fact", id: authId }]));
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Position: Chief Executive Officer", [
    { kind: "profile", field: "desired_roles", value: ["Accountant"] },
  ]));
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Role: Chief Executive Officer", [{ kind: "fact", id: authId }]));
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Title: Chief Executive Officer", [{ kind: "fact", id: authId }]));
  const { result } = edited(s, doc.documentId, addLine(content, "Skills", "Position: Accountant", [
    { kind: "profile", field: "desired_roles", value: ["Accountant"] },
  ]));
  assert.equal(result.status, "validated", result.conflicts.join("; "));
  // Held title + only an unrelated ref still fails (Blocker 1 rule).
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Position: Accountant", [{ kind: "fact", id: authId }]));
});

test("G5R6-2b: other label-prefixed values are judged as their data type", () => {
  const s = setup();
  const authId = declareFact(s.db, { personId: s.personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const locationsRef = [{ kind: "profile", field: "locations", value: ["Logroño, Spain"] }];
  const { result: okLoc } = edited(s, doc.documentId, addLine(content, "Skills", "Location: Logroño, Spain", locationsRef));
  assert.equal(okLoc.status, "validated", okLoc.conflicts.join("; "));
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Location: Madrid", [{ kind: "fact", id: authId }]));
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Location: Logroño, Spain", [{ kind: "fact", id: authId }]));
  const skillsRef = [{ kind: "profile", field: "skills", value: ["SAP", "Excel"] }];
  const { result: okSkill } = edited(s, doc.documentId, addLine(content, "Skills", "Skill: Excel", skillsRef));
  assert.equal(okSkill.status, "validated", okSkill.conflicts.join("; "));
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Skill: Excel", [{ kind: "fact", id: authId }]));
  const historyRef = [{ kind: "history", entryKind: "employment", id: "job-1" }];
  const { result: okEmp } = edited(s, doc.documentId, addLine(content, "Skills", "Employer: Fixture Corp", historyRef));
  assert.equal(okEmp.status, "validated", okEmp.conflicts.join("; "));
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Employer: Fixture Corp", [{ kind: "fact", id: authId }]));
});

// --- Controls ----------------------------------------------------------

test("G5R6-ctrl: 'Target company: Greenfield School' still validates; generated documents still validate", () => {
  const s = setup();
  const resume = buildResumeContent(s.db, s.personId, s.profileId, { company: "Greenfield School" });
  const checkResume = revalidateContent(s.db, s.personId, s.profileId, resume);
  assert.equal(checkResume.ok, true, checkResume.conflicts.join("; "));
  const doc = makeDoc(s, resume);
  assert.equal(doc.status, "validated");
  const letter = buildCoverLetterContent(s.db, s.personId, s.profileId, { company: "Greenfield School", role: "Accountant" });
  const checkLetter = revalidateContent(s.db, s.personId, s.profileId, letter);
  assert.equal(checkLetter.ok, true, checkLetter.conflicts.join("; "));
  const plain = buildResumeContent(s.db, s.personId, s.profileId, {});
  const checkPlain = revalidateContent(s.db, s.personId, s.profileId, plain);
  assert.equal(checkPlain.ok, true, checkPlain.conflicts.join("; "));
});
