// G5 round-3 defect fixes (user reproductions on 48be77e, 2026-10-29).
// Central criterion: EVERY complete rendered claim must be fully
// backed — values, levels, dates and polarity — against ONE source.
// A valid reference plus a partial match does NOT satisfy "zero
// invented facts". Synthetic fixtures only; no network, no submissions.
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
import { resolveSemantic } from "../packages/shared/semantic.mjs";
import {
  buildResumeContent, buildCoverLetterContent, createDocument,
  editDocument, prepareAttachment, auditDocumentVersion, revalidateContent,
} from "../packages/shared/documents.mjs";

function setup(personOverride = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-g5r3-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, { ...FIXTURE_PERSON, ...personOverride });
  const profileId = createProfileFull(db, personId, "Finance", {
    desired_roles: ["Finance Manager"], skills: ["SAP", "Excel"], locations: ["Logroño, Spain"],
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

// --- Finding 1: invented language heading still validates -------------

test("G5R3-1: invented language heading fails, audits as contamination, is never preparable", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const editedContent = JSON.parse(JSON.stringify(content));
  editedContent.sections.push({ heading: "I speak Mandarin fluently.", lines: [] });
  expectBlocked(s, doc.documentId, editedContent);
});

test("G5R3-1: genuine labels and name headers still validate", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const check = revalidateContent(s.db, s.personId, s.profileId, content);
  assert.equal(check.ok, true, check.conflicts.join("; "));
  assert.deepEqual(content.sections.map((x) => x.heading), ["Test Person", "Skills", "Experience", "Education", "Languages"]);
});

// --- Finding 2a: invented budget backed by an Excel ref ----------------

test("G5R3-2a: invented budget with an Excel ref fails and is never preparable", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const editedContent = JSON.parse(JSON.stringify(content));
  findSection(editedContent, "Skills").lines.push({
    text: "I managed a budget of EUR 100 million.",
    refs: [{ kind: "profile", field: "skills", value: ["SAP", "Excel"] }],
  });
  expectBlocked(s, doc.documentId, editedContent);
});

// --- Finding 2b: language level must match ------------------------------

test("G5R3-2b: Mandarin A1 never backs 'Mandarin: native'; A1 backs A1", () => {
  const s = setup({ languages: [{ language: "Mandarin", level: "A1" }, { language: "English", level: "C1" }] });
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const langRef = [{ kind: "person", field: "languages", value: [{ language: "Mandarin", level: "A1" }, { language: "English", level: "C1" }] }];
  const bad = JSON.parse(JSON.stringify(content));
  findSection(bad, "Languages").lines.push({ text: "Mandarin: native", refs: langRef });
  expectBlocked(s, doc.documentId, bad);
  const good = JSON.parse(JSON.stringify(content));
  findSection(good, "Languages").lines.push({ text: "Mandarin: A1", refs: langRef });
  const { result } = edited(s, doc.documentId, good);
  assert.equal(result.status, "validated", result.conflicts.join("; "));
});

// --- Finding 2c: authorisation polarity must match ----------------------

test("G5R3-2c: a 'no' authorisation fact never backs a positive claim (and vice versa holds)", () => {
  const s = setup();
  const noId = declareFact(s.db, { personId: s.personId, concept: "work_authorisation", scope: "ES", value: "no", provenance: "user" });
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const bad = JSON.parse(JSON.stringify(content));
  findSection(bad, "Skills").lines.push({ text: "I am authorized to work in Spain.", refs: [{ kind: "fact", id: noId }] });
  expectBlocked(s, doc.documentId, bad);
  const yesId = declareFact(s.db, { personId: s.personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const good = JSON.parse(JSON.stringify(content));
  findSection(good, "Skills").lines.push({ text: "I am authorized to work in Spain.", refs: [{ kind: "fact", id: yesId }] });
  const { result } = edited(s, doc.documentId, good);
  assert.equal(result.status, "validated", result.conflicts.join("; "));
  const negated = JSON.parse(JSON.stringify(content));
  findSection(negated, "Skills").lines.push({ text: "I am not authorized to work in Spain.", refs: [{ kind: "fact", id: yesId }] });
  // The yes fact now backs the positive claim only; the negated claim
  // must fail while the yes fact is the backing fact.
  expectBlocked(s, doc.documentId, negated);
});

// --- Finding 2d: employment title/employer/dates must ALL match --------

test("G5R3-2d: altered title or altered dates with the same employer fail; the genuine line validates", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const exp = findSection(content, "Experience");
  const empRef = exp.lines[0].refs;
  assert.equal(exp.lines[0].text, "Accountant — Fixture Corp (January 2020 – June 2024)");
  const badTitle = JSON.parse(JSON.stringify(content));
  findSection(badTitle, "Experience").lines[0] = { text: "Chief Financial Officer — Fixture Corp (January 2020 – June 2024)", refs: empRef };
  expectBlocked(s, doc.documentId, badTitle);
  const badDates = JSON.parse(JSON.stringify(content));
  findSection(badDates, "Experience").lines[0] = { text: "Accountant — Fixture Corp (January 2010 – June 2026)", refs: empRef };
  expectBlocked(s, doc.documentId, badDates);
  const { result } = edited(s, doc.documentId, JSON.parse(JSON.stringify(content)));
  assert.equal(result.status, "validated", result.conflicts.join("; "));
});

// --- Finding 2e: education level/subject/institution/dates must match --

test("G5R3-2e: altered subject or institution with the same level fails; the genuine line validates", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, {});
  const doc = makeDoc(s, content);
  const edu = findSection(content, "Education");
  const eduRef = edu.lines[0].refs;
  assert.equal(edu.lines[0].text, "BSc Test Studies — Fixture University (2016 – 2020)");
  const badSubject = JSON.parse(JSON.stringify(content));
  findSection(badSubject, "Education").lines[0] = { text: "BSc Neuroscience — Fixture University (2016 – 2020)", refs: eduRef };
  expectBlocked(s, doc.documentId, badSubject);
  const badInstitution = JSON.parse(JSON.stringify(content));
  findSection(badInstitution, "Education").lines[0] = { text: "BSc Test Studies — Other University (2016 – 2020)", refs: eduRef };
  expectBlocked(s, doc.documentId, badInstitution);
  const { result } = edited(s, doc.documentId, JSON.parse(JSON.stringify(content)));
  assert.equal(result.status, "validated", result.conflicts.join("; "));
});

// --- Finding 3: second invented sentence inside template ----------------

test("G5R3-3: a second invented sentence inside a template line is validated as a claim and fails", () => {
  const s = setup();
  const content = buildCoverLetterContent(s.db, s.personId, s.profileId, { company: "Acme", role: "Accountant" });
  const doc = createDocument(s.db, { personId: s.personId, profileId: s.profileId, kind: "cover_letter", content, gaps: content.gaps ?? [] });
  const bad = JSON.parse(JSON.stringify(content));
  bad.sections[0].lines.push({
    template: true, refs: [],
    text: "I am writing to express my interest in the Accountant position at Acme. I hold a PhD from Harvard University.",
  });
  expectBlocked(s, doc.documentId, bad);
  const { result } = edited(s, doc.documentId, JSON.parse(JSON.stringify(content)));
  assert.equal(result.status, "validated", result.conflicts.join("; "));
});

// --- Finding 4: leading Unless answers the main question ----------------

test("G5R3-4: leading 'Unless' resolves the main clause, with the explicit premise met", () => {
  const s = setup();
  declareFact(s.db, { personId: s.personId, concept: "work_authorisation", scope: "ES", value: "no", provenance: "user" });
  declareFact(s.db, { personId: s.personId, concept: "sponsorship_required", scope: "ES", value: "yes", provenance: "user" });
  const r = resolveSemantic(s.db, s.personId, {
    text: "Unless you are authorized to work in Spain, do you require sponsorship?",
    scope: "ES",
    premise: { concept: "work_authorisation", scope: "ES", expected: "no" },
  });
  assert.equal(r.concept, "sponsorship_required", `expected the main concept, got ${r.concept}`);
  assert.equal(r.value, "yes");
  const unmet = resolveSemantic(s.db, s.personId, {
    text: "Unless you are authorized to work in Spain, do you require sponsorship?",
    scope: "ES",
    premise: { concept: "work_authorisation", scope: "ES", expected: "yes" },
  });
  assert.equal(unmet.kind, "not_applicable", "an unmet premise stays not_applicable, exactly as for If-forms");
});

// --- Finding 5: destination company containing "School" ------------------

test("G5R3-5: 'Greenfield School' as destination company generates and validates; a smuggled sentence still fails", () => {
  const s = setup();
  const content = buildResumeContent(s.db, s.personId, s.profileId, { company: "Greenfield School" });
  const check = revalidateContent(s.db, s.personId, s.profileId, content);
  assert.equal(check.ok, true, check.conflicts.join("; "));
  const doc = makeDoc(s, content);
  const bad = JSON.parse(JSON.stringify(content));
  bad.sections[0].lines[0] = { template: true, refs: [], text: "Target company: Acme. I hold a PhD from Harvard University." };
  expectBlocked(s, doc.documentId, bad);
});
