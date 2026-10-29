// F5 T-V2-044, T-V2-045, T-V2-046, T-V2-047: canonical English
// documents, common PDF/DOCX rendering, append-only versions with
// revalidation, and portal attachment preparation. Synthetic fixtures
// only; no network, no submissions.
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
import { updateProfile } from "../packages/shared/db.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import {
  buildResumeContent, buildCoverLetterContent, createDocument,
  editDocument, listDocumentVersions, getLatestValidatedVersion,
  renderPdf, renderDocx, prepareAttachment, auditDocumentVersion,
  revalidateContent,
} from "../packages/shared/documents.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-docs-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, FIXTURE_PERSON);
  const profileId = createProfileFull(db, personId, "Finance", {
    desired_roles: ["Finance Manager"], skills: ["SAP", "Excel"], locations: ["Logroño, Spain"],
  });
  return { db, personId, profileId };
}

async function pdfText(buf) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => /** @type {any} */ (it).str).join(" ") + "\n";
  }
  return { text, pages: doc.numPages };
}

async function docxText(buf) {
  const result = await mammoth.extractRawText({ buffer: buf });
  return result.value;
}

test("T-V2-044: resume preserves official titles and held date precision; gaps stay out of claims", () => {
  const { db, personId, profileId } = setup();
  const content = buildResumeContent(db, personId, profileId, { role: "Finance Manager" });
  assert.equal(content.language, "en");
  const text = JSON.stringify(content.sections);
  assert.ok(text.includes("Test Person"));
  assert.ok(text.includes("Accountant — Fixture Corp (January 2020 – June 2024)"));
  assert.ok(text.includes("BSc Test Studies — Fixture University (2016 – 2020)"), "year-only dates render without an invented day");
  assert.ok(!text.includes("15"), "no day is invented for year/month precision dates");
  assert.ok(content.sections.flatMap((s) => s.lines).some((l) => l.text.includes("test.person@example.test")), "the stored email is a claim, backed by the person record");
  const emptyProfileId = createProfileFull(db, personId, "Empty", {});
  const emptyContent = buildResumeContent(db, personId, emptyProfileId, {});
  assert.ok(emptyContent.gaps.some((g) => g.includes("skills")), "a missing skill set is a reported gap, never an invented skill");
  assert.ok(!JSON.stringify(emptyContent.sections).includes("SAP"), "no skill is invented for an empty profile");
  const audit = auditDocumentVersion(db, personId, profileId, content);
  assert.equal(audit.contamination, 0);
});

test("T-V2-044: cover letter is company/role specific with verifiable arguments only", () => {
  const { db, personId, profileId } = setup();
  const letter = buildCoverLetterContent(db, personId, profileId, { company: "Acme Corp", role: "Finance Manager" });
  const text = letter.sections[0].lines.map((l) => l.text).join(" ");
  assert.ok(text.includes("Acme Corp"));
  assert.ok(text.includes("Finance Manager"));
  assert.ok(text.includes("Fixture Corp"));
  assert.ok(text.includes("SAP"));
  assert.ok(!text.includes("Harvard"), "nothing is invented about education");
  const generic = buildCoverLetterContent(db, personId, profileId, {});
  const genericText = generic.sections[0].lines.map((l) => l.text).join(" ");
  assert.ok(genericText.includes("Hiring Team"), "a missing company yields a generic addressee, never an invented company");
  assert.ok(generic.gaps.some((g) => g.includes("company")));
});

test("T-V2-045: PDF and DOCX render the same canonical content, open, extract and paginate", async () => {
  const { db, personId, profileId } = setup();
  const content = buildResumeContent(db, personId, profileId, { role: "Finance Manager" });
  const pdf = renderPdf(content);
  assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-");
  const extracted = await pdfText(pdf);
  assert.ok(extracted.text.includes("Test Person"));
  assert.ok(extracted.text.includes("Fixture Corp"));
  assert.ok(extracted.text.includes("SAP"));
  assert.ok(extracted.pages >= 1);
  const docx = renderDocx(content);
  assert.equal(docx.subarray(0, 2).toString("latin1"), "PK");
  const docxExtracted = await docxText(docx);
  assert.ok(docxExtracted.includes("Test Person"));
  assert.ok(docxExtracted.includes("Fixture Corp"));
  assert.ok(docxExtracted.includes("SAP"), "PDF and DOCX carry the same facts");
  // Long case: many lines paginate and stay fully extractable.
  const longSections = [{ heading: "Experience", lines: Array.from({ length: 120 }, (_, i) => ({ text: `Repeated verifiable line ${i} for Fixture Corp`, refs: [{ kind: "profile", field: "skills", value: ["SAP", "Excel"] }], template: false })) }];
  const longPdf = renderPdf({ title: "Long", sections: longSections });
  const longExtracted = await pdfText(longPdf);
  assert.ok(longExtracted.pages > 1, "a long document paginates");
  assert.ok(longExtracted.text.includes("Repeated verifiable line 119"), "the last page is extractable too");
});

test("T-V2-046: versions are append-only, edits revalidate, conflicts never validate", () => {
  const { db, personId, profileId } = setup();
  const content = buildResumeContent(db, personId, profileId, {});
  const created = createDocument(db, { personId, profileId, kind: "resume", content, gaps: content.gaps });
  assert.equal(created.version, 1);
  assert.equal(created.status, "validated");
  const edited = { ...content, sections: [...content.sections, { heading: "Extra", lines: [{ text: "SAP", refs: [{ kind: "profile", field: "skills", value: ["SAP", "Excel"] }] }] }] };
  const v2 = editDocument(db, created.documentId, edited);
  assert.equal(v2.version, 2);
  assert.equal(v2.status, "validated");
  const versions = listDocumentVersions(db, created.documentId);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].version, 1);
  assert.equal(versions[0].content.sections.length, content.sections.length, "v1 is never rewritten by an edit");
  const bad = { ...content, sections: [{ heading: "Claims", lines: [{ text: "I speak Mandarin fluently", refs: [] }] }] };
  const v3 = editDocument(db, created.documentId, bad);
  assert.equal(v3.status, "needs_resolution");
  assert.ok(v3.conflicts.some((c) => c.includes("unreferenced claim")));
  const latest = getLatestValidatedVersion(db, created.documentId);
  assert.equal(latest.version, 2, "the latest validated version stays v2 after a conflicting edit");
  const spanish = { ...content, language: "es" };
  const v4 = editDocument(db, created.documentId, spanish);
  assert.equal(v4.status, "needs_resolution");
  assert.ok(v4.conflicts.some((c) => c.includes("English")));
});

test("T-V2-046: a changed retained value conflicts the old version instead of silently passing", () => {
  const { db, personId, profileId } = setup();
  const content = buildResumeContent(db, personId, profileId, {});
  const created = createDocument(db, { personId, profileId, kind: "resume", content, gaps: content.gaps });
  const profile = listDocumentVersions(db, created.documentId)[0];
  assert.equal(profile.status, "validated");
  // Change the retained value after versioning.
  const current = /** @type {any} */ (db.prepare("SELECT body_json FROM profiles WHERE id = ?").get(profileId));
  const body = JSON.parse(current.body_json);
  body.skills = ["SAP", "Excel", "Power BI"];
  updateProfile(db, profileId, body);
  const audit = auditDocumentVersion(db, personId, profileId, content);
  assert.ok(audit.contamination > 0, "a stale claim against changed retained data is contamination, not a pass");
});

test("T-V2-047: attachments check format, size and role; impossible formats fail explainably", () => {
  const { db, personId, profileId } = setup();
  const content = buildResumeContent(db, personId, profileId, {});
  const created = createDocument(db, { personId, profileId, kind: "resume", content, gaps: content.gaps });
  const ok = prepareAttachment(db, { documentId: created.documentId, format: "pdf", role: "resume", portalRequirements: { allowedFormats: ["pdf", "docx"], maxBytes: 5_000_000 } });
  assert.equal(ok.mime, "application/pdf");
  assert.equal(ok.sha256.length, 64);
  assert.ok(ok.filename.endsWith(".pdf"));
  assert.equal(ok.status, "prepared");
  assert.equal(ok.portalReceipt, null, "prepared is not portal receipt");
  assert.throws(
    () => prepareAttachment(db, { documentId: created.documentId, format: "pdf", role: "resume", portalRequirements: { allowedFormats: ["docx"] } }),
    /requires one of: docx/,
  );
  assert.throws(
    () => prepareAttachment(db, { documentId: created.documentId, format: "txt", role: "resume" }),
    /not a format this system generates/,
  );
  assert.throws(
    () => prepareAttachment(db, { documentId: created.documentId, format: "pdf", role: "cover_letter" }),
    /does not match document kind/,
  );
  assert.throws(
    () => prepareAttachment(db, { documentId: created.documentId, format: "pdf", role: "resume", portalRequirements: { maxBytes: 10 } }),
    /exceeds the portal limit/,
  );
  assert.equal(revalidateContent(db, personId, profileId, content).ok, true);
});
