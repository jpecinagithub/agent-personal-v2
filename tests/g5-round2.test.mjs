// G5 round-2 defect fixes (user reproductions on 894e470, 2026-10-29).
// Each test reproduces the user's exact case and asserts the fixed
// behaviour. Synthetic fixtures only; no network, no submissions.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { createProfileFull } from "../packages/shared/profiles.mjs";
import { declareFact } from "../packages/shared/facts.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import {
  parseQuestionText, resolveSemantic, listAliases, recordAlias,
} from "../packages/shared/semantic.mjs";
import {
  buildResumeContent, buildCoverLetterContent, createDocument,
  prepareAttachment, auditDocumentVersion, revalidateContent,
  renderPdf, renderDocx, assertPdfRepresentable,
} from "../packages/shared/documents.mjs";

function setup(personOverride = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-g5r2-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, { ...FIXTURE_PERSON, ...personOverride });
  const profileId = createProfileFull(db, personId, "Finance", {
    desired_roles: ["Finance Manager"], skills: ["SAP", "Excel"], locations: ["Logroño, Spain"],
  });
  return { db, personId, profileId };
}

async function pdfText(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    text += (await (await doc.getPage(i)).getTextContent()).items.map((it) => /** @type {any} */ (it).str).join(" ") + "\n";
  }
  return { text, pages: doc.numPages };
}

function assertStrictXref(buf) {
  const s = buf.toString("latin1");
  const m = s.match(/startxref\s*(\d+)/);
  assert.ok(m, "startxref present");
  const xrefPos = Number(m[1]);
  assert.equal(s.slice(xrefPos, xrefPos + 4), "xref", "startxref points exactly at xref");
  const lines = s.slice(xrefPos).split("\n");
  const count = Number(lines[1].trim().split(/\s+/)[1]);
  for (let i = 1; i < count; i++) {
    const off = Number((lines[2 + i] || "").slice(0, 10));
    assert.equal(s.slice(off, off + `${i} 0 obj`.length), `${i} 0 obj`, `xref entry ${i} offset exact`);
  }
}

// --- Finding 1: language claim content matching --------------------------

test("G5R2-1: a Mandarin claim backed by an Excel skill ref fails, audits as contamination", () => {
  const { db, personId, profileId } = setup();
  const content = buildResumeContent(db, personId, profileId, {});
  content.sections.push({ heading: "Languages", lines: [{ text: "I speak Mandarin", refs: [{ kind: "profile", field: "skills", value: ["SAP", "Excel"] }] }] });
  const check = revalidateContent(db, personId, profileId, content);
  assert.equal(check.ok, false);
  assert.ok(check.conflicts.some((c) => c.includes("language claim not supported")));
  assert.throws(() => createDocument(db, { personId, profileId, kind: "resume", content }), /language claim not supported/);
  assert.ok(auditDocumentVersion(db, personId, profileId, content).contamination > 0);
});

test("G5R2-1: a Mandarin claim backed by a Mandarin language entry validates", () => {
  const { db, personId, profileId } = setup({ languages: [{ language: "Mandarin", level: "B2" }, { language: "English", level: "C1" }] });
  const content = buildResumeContent(db, personId, profileId, {});
  content.sections.push({ heading: "Languages", lines: [{ text: "I speak Mandarin", refs: [{ kind: "person", field: "languages", value: [{ language: "Mandarin", level: "B2" }, { language: "English", level: "C1" }] }] }] });
  assert.equal(revalidateContent(db, personId, profileId, content).ok, true);
  // Generated language lines still validate.
  const generated = buildResumeContent(db, personId, profileId, {});
  assert.equal(revalidateContent(db, personId, profileId, generated).ok, true);
  // A listed skill that is not held fails; held skills still pass.
  const listed = buildResumeContent(db, personId, profileId, {});
  listed.sections.push({ heading: "Skills", lines: [{ text: "My skills include SAP, Mandarin", refs: [{ kind: "profile", field: "skills", value: ["SAP", "Excel"] }] }] });
  assert.equal(revalidateContent(db, personId, profileId, listed).ok, false, "Mandarin is not a held skill");
});

// --- Finding 2: exact education levels ------------------------------------

test("G5R2-2: a BSc entry cannot be upgraded into a PhD claim", () => {
  const { db, personId, profileId } = setup();
  const content = buildResumeContent(db, personId, profileId, {});
  content.sections.push({ heading: "Education", lines: [{ text: "PhD in Test Studies — Fixture University (2016 – 2020)", refs: [{ kind: "history", entryKind: "education", id: "edu-1", value: { title: "BSc Test Studies", institution: "Fixture University", start: "2016", end: "2020" } }] }] });
  const check = revalidateContent(db, personId, profileId, content);
  assert.equal(check.ok, false);
  assert.ok(check.conflicts.some((c) => c.includes("education claim not supported")));
  // Same-level claims still validate, including level aliases.
  const same = buildResumeContent(db, personId, profileId, {});
  same.sections.push({ heading: "Education", lines: [{ text: "BSc in Test Studies — Fixture University (2016 – 2020)", refs: [{ kind: "history", entryKind: "education", id: "edu-1", value: { title: "BSc Test Studies", institution: "Fixture University", start: "2016", end: "2020" } }] }] });
  assert.equal(revalidateContent(db, personId, profileId, same).ok, true);
  const { db: db2, personId: p2, profileId: pr2 } = setup({
    education: [{ id: "edu-9", institution: "Fixture University", title: "PhD in Test Studies", start: "2016", end: "2020" }],
  });
  const doc2 = buildResumeContent(db2, p2, pr2, {});
  doc2.sections.push({ heading: "Education", lines: [{ text: "Doctorate in Test Studies — Fixture University (2016 – 2020)", refs: [{ kind: "history", entryKind: "education", id: "edu-9", value: { title: "PhD in Test Studies", institution: "Fixture University", start: "2016", end: "2020" } }] }] });
  assert.equal(revalidateContent(db2, p2, pr2, doc2).ok, true, "doctorate is an alias of the PhD level group");
});

// --- Finding 3: template prefix smuggling ---------------------------------

test("G5R2-3: a claim after a template prefix is validated, pure furniture stays exempt", () => {
  const { db, personId, profileId } = setup();
  const base = buildResumeContent(db, personId, profileId, {});
  const smuggled = { ...base, sections: [...base.sections, { heading: "Extra", lines: [{ text: "I am writing to express my interest in the Finance Manager position. I have a PhD from MIT", refs: [], template: true }] }] };
  assert.equal(revalidateContent(db, personId, profileId, smuggled).ok, false, "interest prefix never exempts a trailing claim");
  const smuggledCompany = { ...base, sections: [...base.sections, { heading: "Extra", lines: [{ text: "Target company: Acme. I have a PhD from MIT", refs: [], template: true }] }] };
  assert.equal(revalidateContent(db, personId, profileId, smuggledCompany).ok, false, "target-company prefix never exempts a trailing claim");
  const pure = { ...base, sections: [...base.sections, { heading: "Extra", lines: [
    { text: "Dear Acme Hiring Team,", refs: [], template: true },
    { text: "I am writing to express my interest in the Finance Manager position at Acme.", refs: [], template: true },
    { text: "Target company: Acme", refs: [], template: true },
    { text: "Sincerely, Test Person", refs: [], template: true },
  ] }] };
  assert.equal(revalidateContent(db, personId, profileId, pure).ok, true, "pure furniture lines stay exempt");
});

// --- Finding 4: stale alias scope ------------------------------------------

test("G5R2-4: a stale BE alias never overrides a freshly parsed ES scope", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const beFact = declareFact(db, { personId, concept: "work_authorisation", scope: "BE", value: "no", provenance: "user" });
  recordAlias(db, personId, { variantText: "Would you be authorized to work in Spain?", concept: "work_authorisation", scope: "BE", negated: false, evidenceFactId: beFact });
  const r = resolveSemantic(db, personId, { text: "Would you be authorized to work in Spain?" });
  assert.equal(r.kind, "declared");
  assert.equal(r.scope, "ES");
  assert.equal(r.value, "yes");
  const aliases = listAliases(db, personId);
  assert.equal(aliases.length, 1, "no second alias is written");
  assert.equal(aliases[0].scope, "BE", "the stale alias row is not re-saved under another scope");
});

// --- Finding 5: conditional matrix ------------------------------------------

test("G5R2-5: conditional shapes resolve from the main clause only", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  declareFact(db, { personId, concept: "sponsorship_required", scope: "ES", value: "no", provenance: "user" });
  const trailingIf = resolveSemantic(db, personId, { text: "Do you require sponsorship, if you are not authorized to work in Spain?" });
  assert.equal(trailingIf.concept, "sponsorship_required");
  assert.equal(trailingIf.value, "no", "premise negation must not flip the main answer");
  const trailingBare = resolveSemantic(db, personId, { text: "Are you authorized to work in Spain if you do not require sponsorship?" });
  assert.equal(trailingBare.concept, "work_authorisation");
  assert.equal(trailingBare.value, "yes");
  const provided = resolveSemantic(db, personId, { text: "Do you require sponsorship, provided that you are authorized to work in Spain?" });
  assert.equal(provided.concept, "sponsorship_required");
  assert.equal(provided.value, "no");
  const providedLeading = resolveSemantic(db, personId, { text: "Provided that you are authorized to work in Spain, do you require sponsorship?" });
  assert.equal(providedLeading.concept, "sponsorship_required");
  assert.equal(providedLeading.value, "no");
  const asLongAs = resolveSemantic(db, personId, { text: "Are you authorized to work in Spain as long as you do not require sponsorship?" });
  assert.equal(asLongAs.concept, "work_authorisation");
  assert.equal(asLongAs.value, "yes");
  const unless = resolveSemantic(db, personId, { text: "Do you require sponsorship unless you are authorized to work in Spain?" });
  assert.equal(unless.concept, "sponsorship_required");
  assert.equal(unless.value, "no");
  const unlessMain = resolveSemantic(db, personId, { text: "Are you authorized to work in Spain unless you require sponsorship?" });
  assert.equal(unlessMain.concept, "work_authorisation");
  assert.equal(unlessMain.value, "yes");
  const noConcept = resolveSemantic(db, personId, { text: "If you require sponsorship, what is the weather like in Spain?" });
  assert.equal(noConcept.kind, "needs_human", "a main clause with no concept is a human question, never the premise's concept");
});

// --- Finding 6: ALL-CAPS questions ------------------------------------------

test("G5R2-6: ALL-CAPS questions resolve identically to mixed-case ones", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  declareFact(db, { personId, concept: "work_authorisation", scope: "BE", value: "no", provenance: "user" });
  declareFact(db, { personId, concept: "sponsorship_required", scope: "ES", value: "no", provenance: "user" });
  declareFact(db, { personId, concept: "veteran_status", scope: "", value: "yes", provenance: "user" });
  const spain = resolveSemantic(db, personId, { text: "WOULD YOU BE AUTHORIZED TO WORK IN SPAIN?" });
  assert.equal(spain.scope, "ES");
  assert.equal(spain.value, "yes");
  const premise = resolveSemantic(db, personId, { text: "IF YOU DO NOT REQUIRE SPONSORSHIP, ARE YOU AUTHORIZED TO WORK IN SPAIN?", scope: "ES", premise: { concept: "sponsorship_required", scope: "ES", expected: "no" } });
  assert.equal(premise.kind, "declared");
  assert.equal(premise.value, "yes");
  const veteran = resolveSemantic(db, personId, { text: "ARE YOU NOT A VETERAN?" });
  assert.equal(veteran.value, "no");
  assert.equal(parseQuestionText("WOULD YOU BE AUTHORIZED TO WORK?").scope, "", "caps BE verb never becomes Belgium");
  assert.equal(parseQuestionText("ARE YOU AUTHORIZED TO WORK AT ACME?").scope, "", "caps AT preposition never becomes Austria");
  assert.equal(parseQuestionText("ARE YOU AUTHORIZED TO WORK IN BE?").scope, "BE", "a genuine caps code after 'in' still resolves");
  assert.equal(parseQuestionText("ARE YOU AUTHORIZED TO WORK? SCOPE: ES").scope, "ES", "a caps scope marker still resolves");
});

// --- Finding 7: cover letter without a company (regression) ------------------

test("G5R2-7: a cover letter without a target company generates and validates", () => {
  const { db, personId, profileId } = setup();
  const content = buildCoverLetterContent(db, personId, profileId, {});
  assert.ok(content.sections[0].lines.some((l) => l.text === "Dear Hiring Team,"), "generic greeting, no company invented");
  const created = createDocument(db, { personId, profileId, kind: "cover_letter", content, gaps: content.gaps });
  assert.equal(created.status, "validated");
  const attached = prepareAttachment(db, { documentId: created.documentId, format: "pdf", role: "cover_letter" });
  assert.equal(attached.status, "prepared");
});

// --- Finding 8: legitimate job at a school (regression) -----------------------

test("G5R2-8: a legitimate employment entry at a school validates and attaches", () => {
  const { db, personId, profileId } = setup({
    employment: [{ id: "job-9", employer: "Springfield High School", title: "Teacher", start: "2020", end: "2024" }],
  });
  const content = buildResumeContent(db, personId, profileId, {});
  const created = createDocument(db, { personId, profileId, kind: "resume", content, gaps: content.gaps });
  assert.equal(created.status, "validated");
  const attached = prepareAttachment(db, { documentId: created.documentId, format: "pdf", role: "resume" });
  assert.equal(attached.status, "prepared");
  // An education claim smuggled behind an employment ref still fails.
  const smuggled = buildResumeContent(db, personId, profileId, {});
  smuggled.sections.push({ heading: "Education", lines: [{ text: "PhD in Education — Springfield High School (2020 – 2024)", refs: [{ kind: "history", entryKind: "employment", id: "job-9", value: { title: "Teacher", employer: "Springfield High School", start: "2020", end: "2024" } }] }] });
  assert.equal(revalidateContent(db, personId, profileId, smuggled).ok, false, "a level claim backed only by employment never validates");
});

// --- Finding 9: Polish names in PDF --------------------------------------------

test("G5R2-9: Łukasz Żółć renders exactly in PDF and DOCX and attaches", async () => {
  const { db, personId, profileId } = setup({ full_name: "Łukasz Żółć" });
  const content = buildResumeContent(db, personId, profileId, {});
  const pdf = renderPdf(content);
  const { text } = await pdfText(pdf);
  assert.ok(text.includes("Łukasz Żółć"), `pdf.js must extract the Polish name exactly, got: ${text}`);
  assert.ok(!text.includes("?ukasz"), "no mangled '?' name");
  assertStrictXref(pdf);
  const docx = renderDocx(content);
  const mammothResult = await mammoth.extractRawText({ buffer: docx });
  assert.ok(mammothResult.value.includes("Łukasz Żółć"), "DOCX keeps the Polish name exactly");
  const created = createDocument(db, { personId, profileId, kind: "resume", content, gaps: content.gaps });
  const attached = prepareAttachment(db, { documentId: created.documentId, format: "pdf", role: "resume" });
  assert.equal(attached.status, "prepared");
});

test("G5R2-9: a truly unrepresentable character fails explainably and is never prepared", () => {
  const { db, personId, profileId } = setup({ full_name: "Test Person" });
  const content = buildResumeContent(db, personId, profileId, {});
  content.title = "李雷 — Resume";
  assert.throws(() => renderPdf(content), /PDF cannot represent character/);
  assert.throws(() => assertPdfRepresentable(content), /U\+/);
  const good = buildResumeContent(db, personId, profileId, {});
  const created = createDocument(db, { personId, profileId, kind: "resume", content: good, gaps: good.gaps });
  // Collision: a Polish char together with the Latin-1 char owning its code.
  const collision = buildResumeContent(db, personId, profileId, {});
  collision.title = "Łukasz ³ — Resume";
  assert.throws(() => renderPdf(collision), /PDF cannot represent character/);
});
