// G5 round-7 blocker (user reproduction on e74bbe3, 2026-10-30).
// Cross-typing through the generic label route: the value was checked
// against SOME retained field, but not against the type the label
// declares, and the shared phraseRefSupports helper accepted a ref
// from any field. Each label now restricts its admissible sources to
// its own type. Synthetic fixtures only; no network, no submissions.
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-g5r7-"));
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
  assert.ok(audit.contamination > 0, "audit must count the cross-typed claim as contamination");
  assert.throws(() => prepareAttachment(setupOut.db, { documentId: docId, version: result.version, format: "docx", role: "resume" }), "a needs_resolution version must never be preparable");
}

function addLine(content, heading, lineText, refs) {
  const next = JSON.parse(JSON.stringify(content));
  let sec = next.sections.find((s) => s.heading === heading);
  if (!sec) { sec = { heading, lines: [] }; next.sections.push(sec); }
  sec.lines.push({ text: lineText, refs });
  return next;
}

// --- The four cross-typing cases ---------------------------------------

test("G5R7-1: cross-typed labels fail with only a desired_roles ref", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const rolesRef = [{ kind: "profile", field: "desired_roles", value: ["Accountant"] }];
  for (const line of ["Skill: Accountant", "Location: Accountant", "Employer: Accountant", "Language: Accountant"]) {
    expectBlocked(s, doc.documentId, addLine(content, "Skills", line, rolesRef));
  }
});

// --- Valid counterparts with admissible refs ----------------------------

test("G5R7-2: each label validates with a ref of its own type", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const cases = [
    ["Skill: Excel", [{ kind: "profile", field: "skills", value: ["SAP", "Excel"] }]],
    ["Location: Logroño, Spain", [{ kind: "profile", field: "locations", value: ["Logroño, Spain"] }]],
    ["Employer: Fixture Corp", [{ kind: "history", entryKind: "employment", id: "job-1" }]],
    ["Language: English", [{ kind: "person", field: "languages", value: [{ language: "English", level: "C1" }] }]],
    ["Language: English: C1", [{ kind: "person", field: "languages", value: [{ language: "English", level: "C1" }] }]],
    ["Position: Accountant", [{ kind: "profile", field: "desired_roles", value: ["Accountant"] }]],
  ];
  for (const [line, refs] of cases) {
    const { result } = edited(s, doc.documentId, addLine(content, "Skills", line, refs));
    assert.equal(result.status, "validated", `${line}: ${result.conflicts.join("; ")}`);
  }
});

// --- Language via a compatible linguistic fact; ref-kind isolation -----

test("G5R7-3: language via linguistic fact validates; held language with a wrong-kind ref fails", () => {
  const s = setup();
  const langFact = declareFact(s.db, { personId: s.personId, concept: "language", value: "Spanish", provenance: "user" });
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const { result: okFact } = edited(s, doc.documentId, addLine(content, "Skills", "Language: Spanish", [{ kind: "fact", id: langFact }]));
  assert.equal(okFact.status, "validated", okFact.conflicts.join("; "));
  // English IS held as a language, but a desired_roles ref must never support a Language value.
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Language: English", [
    { kind: "profile", field: "desired_roles", value: ["Accountant"] },
  ]));
});

// --- Title labels audit: skills refs never support a title -------------

test("G5R7-4: title labels accept only desired_roles and employment-title refs", () => {
  const s = setup({}, { skills: ["SAP", "Excel", "Accountant"] });
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  // "Accountant" is held as a skill here, but a skills ref must not support a title value.
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Position: Accountant", [
    { kind: "profile", field: "skills", value: ["SAP", "Excel", "Accountant"] },
  ]));
  // A value held only as a skill is not a held title at all.
  expectBlocked(s, doc.documentId, addLine(content, "Skills", "Position: Excel", [
    { kind: "profile", field: "skills", value: ["SAP", "Excel", "Accountant"] },
  ]));
  // Mixed refs: one admissible supporting ref still passes.
  const { result: okMix } = edited(s, doc.documentId, addLine(content, "Skills", "Skill: Excel", [
    { kind: "profile", field: "desired_roles", value: ["Accountant"] },
    { kind: "profile", field: "skills", value: ["SAP", "Excel", "Accountant"] },
  ]));
  assert.equal(okMix.status, "validated", okMix.conflicts.join("; "));
});

// --- Controls ------------------------------------------------------------

test("G5R7-ctrl: generated documents and Target company still validate", () => {
  const s = setup();
  const resume = buildResumeContent(s.db, s.personId, s.profileId, { company: "Greenfield School" });
  const checkResume = revalidateContent(s.db, s.personId, s.profileId, resume);
  assert.equal(checkResume.ok, true, checkResume.conflicts.join("; "));
  const doc = makeDoc(s, resume);
  assert.equal(doc.status, "validated");
  const letter = buildCoverLetterContent(s.db, s.personId, s.profileId, { company: "Greenfield School", role: "Accountant" });
  const checkLetter = revalidateContent(s.db, s.personId, s.profileId, letter);
  assert.equal(checkLetter.ok, true, checkLetter.conflicts.join("; "));
});
