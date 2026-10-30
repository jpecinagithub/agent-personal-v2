// G5 round-4 defect fixes (user reproductions on e95bad7, 2026-10-30).
// Persisting common problem: a reference must back the COMPLETE
// rendered claim. Free edits that cannot be fully interpreted must
// end up needs_resolution — never silently degrade to a weaker
// validatable claim. Synthetic fixtures only; no network, no submissions.
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
  buildResumeContent, createDocument,
  editDocument, prepareAttachment, auditDocumentVersion, revalidateContent,
} from "../packages/shared/documents.mjs";

function setup(personOverride = {}, profileBody = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-g5r4-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, { ...FIXTURE_PERSON, ...personOverride });
  const profileId = createProfileFull(db, personId, "Finance", {
    desired_roles: ["Finance Manager"], skills: ["SAP", "Excel"], locations: ["Logroño, Spain"], ...profileBody,
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

function findSection(content, heading) {
  return content.sections.find((s) => s.heading === heading);
}

function addLine(content, heading, lineText, refs, extra = {}) {
  const next = JSON.parse(JSON.stringify(content));
  findSection(next, heading).lines.push({ text: lineText, refs, ...extra });
  return next;
}

// --- Finding 1a: role line must name a held desired role -----------

test("G5R4-1a: 'Chief Executive Officer' backed only by an Accountant desired_roles ref fails", () => {
  const s = setup({}, { desired_roles: ["Accountant"] });
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const bad = addLine(content, "Skills", "Chief Executive Officer", [{ kind: "profile", field: "desired_roles", value: ["Accountant"] }]);
  expectBlocked(s, doc.documentId, bad);
  const good = addLine(content, "Skills", "Accountant", [{ kind: "profile", field: "desired_roles", value: ["Accountant"] }]);
  const { result } = edited(s, doc.documentId, good);
  assert.equal(result.status, "validated", result.conflicts.join("; "));
});

// --- Finding 1b: any email in text must equal the held email -------

test("G5R4-1b: 'Contact: fake@example.test' fails although the real email ref is kept", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const bad = addLine(content, "Skills", "Contact: fake@example.test", [{ kind: "person", field: "email", value: "test.person@example.test" }]);
  expectBlocked(s, doc.documentId, bad);
  const check = revalidateContent(s.db, s.personId, s.profileId, content);
  assert.equal(check.ok, true, `generated contact lines still validate: ${check.conflicts.join("; ")}`);
});

// --- Finding 1c: an authorisation fact never backs an award --------

test("G5R4-1c: 'I won the Nobel Prize.' backed by an authorisation fact fails; an award fact backs it", () => {
  const s = setup();
  const authId = declareFact(s.db, { personId: s.personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const bad = addLine(content, "Skills", "I won the Nobel Prize.", [{ kind: "fact", id: authId }]);
  expectBlocked(s, doc.documentId, bad);
  const awardId = declareFact(s.db, { personId: s.personId, concept: "award", value: "Nobel Prize", provenance: "user" });
  const good = addLine(content, "Skills", "I won the Nobel Prize.", [{ kind: "fact", id: awardId }]);
  const { result } = edited(s, doc.documentId, good);
  assert.equal(result.status, "validated", result.conflicts.join("; "));
});

// --- Finding 2a: month precision is compared, not just years --------

test("G5R4-2a: December 2020 fails against a January 2020 held start; January validates", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const jobRef = [{ kind: "history", entryKind: "employment", id: "job-1" }];
  const bad = addLine(content, "Experience", "Accountant — Fixture Corp (December 2020 – June 2024)", jobRef);
  expectBlocked(s, doc.documentId, bad);
  const good = addLine(content, "Experience", "Accountant — Fixture Corp (January 2020 – June 2024)", jobRef);
  const { result } = edited(s, doc.documentId, good);
  assert.equal(result.status, "validated", result.conflicts.join("; "));
  // A month asserted where the held date is year-only also invents precision.
  const eduRef = [{ kind: "history", entryKind: "education", id: "edu-1" }];
  const inventedMonth = addLine(content, "Education", "BSc Test Studies — Fixture University (January 2016 – 2020)", eduRef);
  expectBlocked(s, doc.documentId, inventedMonth);
});

// --- Finding 2b: currency is checked jointly with the number --------

test("G5R4-2b: EUR 100 million fails against a USD fact; USD 100 million validates", () => {
  const s = setup();
  const budgetId = declareFact(s.db, { personId: s.personId, concept: "budget_managed", value: { amount: 100000000, currency: "USD" }, provenance: "user" });
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const bad = addLine(content, "Skills", "I managed a budget of EUR 100 million.", [{ kind: "fact", id: budgetId }]);
  expectBlocked(s, doc.documentId, bad);
  const good = addLine(content, "Skills", "I managed a budget of USD 100 million.", [{ kind: "fact", id: budgetId }]);
  const { result } = edited(s, doc.documentId, good);
  assert.equal(result.status, "validated", result.conflicts.join("; "));
});

// --- Finding 3: unrecognised language qualifier never degrades -----

test("G5R4-3: 'Mandarin: mother tongue' fails with A1 held, validates with native held", () => {
  const s = setup({ languages: [{ language: "Mandarin", level: "A1" }, { language: "English", level: "C1" }] });
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const langRef = [{ kind: "person", field: "languages", value: [{ language: "Mandarin", level: "A1" }, { language: "English", level: "C1" }] }];
  const bad = addLine(content, "Languages", "Mandarin: mother tongue", langRef);
  expectBlocked(s, doc.documentId, bad);
  const goodA1 = addLine(content, "Languages", "Mandarin: A1", langRef);
  const { result: r1 } = edited(s, doc.documentId, goodA1);
  assert.equal(r1.status, "validated", r1.conflicts.join("; "));

  const s2 = setup({ languages: [{ language: "Mandarin", level: "native" }] });
  const content2 = buildResumeContent(s2.db, s2.personId, s2.profileId, {});
  const doc2 = makeDoc(s2, content2);
  const nativeRef = [{ kind: "person", field: "languages", value: [{ language: "Mandarin", level: "native" }] }];
  const goodNative = addLine(content2, "Languages", "Mandarin: mother tongue", nativeRef);
  const { result: r2 } = edited(s2, doc2.documentId, goodNative);
  assert.equal(r2.status, "validated", r2.conflicts.join("; "));
});

// --- Finding 4a: headings are default-deny ---------------------------

test("G5R4-4a: 'Winner of the Nobel Prize' heading fails; genuine labels still validate", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const bad = JSON.parse(JSON.stringify(content));
  bad.sections.push({ heading: "Winner of the Nobel Prize", lines: [] });
  expectBlocked(s, doc.documentId, bad);
  const check = revalidateContent(s.db, s.personId, s.profileId, content);
  assert.equal(check.ok, true, `generated headings still validate: ${check.conflicts.join("; ")}`);
  const extra = JSON.parse(JSON.stringify(content));
  extra.sections.push({ heading: "Extra", lines: [{ text: "SAP", refs: [{ kind: "profile", field: "skills", value: ["SAP", "Excel"] }] }] });
  assert.equal(revalidateContent(s.db, s.personId, s.profileId, extra).ok, true, "Extra label stays valid");
});

// --- Finding 4b: template parameter must be a single entity --------

test("G5R4-4b: 'Target company: Acme. Nobel Prize winner' fails; plain names validate", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const bad = addLine(content, "Skills", "Target company: Acme. Nobel Prize winner", [], { template: true });
  expectBlocked(s, doc.documentId, bad);
  for (const company of ["Acme", "Greenfield School", "St. Louis Foods", "U.S. Steel"]) {
    const good = addLine(content, "Skills", `Target company: ${company}`, [], { template: true });
    const { result } = edited(s, doc.documentId, good);
    assert.equal(result.status, "validated", `${company}: ${result.conflicts.join("; ")}`);
  }
});

// --- No-degradation also for skill qualifiers ------------------------

test("G5R4-3b: 'Excel: expert' fails with only 'Excel' held; bare 'Excel' validates", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const skillsRef = [{ kind: "profile", field: "skills", value: ["SAP", "Excel"] }];
  const bad = addLine(content, "Skills", "Excel: expert", skillsRef);
  expectBlocked(s, doc.documentId, bad);
  const good = addLine(content, "Skills", "Excel", skillsRef);
  const { result } = edited(s, doc.documentId, good);
  assert.equal(result.status, "validated", result.conflicts.join("; "));
});
