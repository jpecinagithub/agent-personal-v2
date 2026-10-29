// G5 defect fixes (user reproductions on 0cc14e5, 2026-10-29).
// Each test reproduces the user's exact case and asserts the fixed
// behaviour. Synthetic fixtures only; no network, no submissions.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { createProfileFull } from "../packages/shared/profiles.mjs";
import { declareFact } from "../packages/shared/facts.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import {
  parseQuestionText, resolveSemantic, listAliases, formatDateRange,
  auditResolvedAnswers,
} from "../packages/shared/semantic.mjs";
import {
  buildResumeContent, createDocument, editDocument, prepareAttachment,
  auditDocumentVersion, revalidateContent, renderPdf, pdfEncodeText,
} from "../packages/shared/documents.mjs";

function setup(personOverride = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-g5fix-"));
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

/** Strict xref validation: every offset must point exactly at its object header. */
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

// --- Defect 1: claim-to-support validation -------------------------------

test("G5-1: invented doctorate via an unrelated Excel ref fails, is not attachable, audits as contamination", () => {
  const { db, personId, profileId } = setup();
  const content = buildResumeContent(db, personId, profileId, {});
  content.sections.push({ heading: "Education", lines: [{ text: "PhD in Astrophysics — Invented University (2020 – 2024)", refs: [{ kind: "profile", field: "skills", value: ["SAP", "Excel"] }] }] });
  const check = revalidateContent(db, personId, profileId, content);
  assert.equal(check.ok, false);
  assert.ok(check.conflicts.some((c) => c.includes("not supported by its references")));
  assert.throws(() => createDocument(db, { personId, profileId, kind: "resume", content }), /not supported/);
  const audit = auditDocumentVersion(db, personId, profileId, content);
  assert.ok(audit.contamination > 0, "audit must count the unsupported claim as contamination");
  // An edit carrying it becomes needs_resolution and cannot be attached.
  const good = buildResumeContent(db, personId, profileId, {});
  const created = createDocument(db, { personId, profileId, kind: "resume", content: good, gaps: good.gaps });
  const edited = editDocument(db, created.documentId, content);
  assert.equal(edited.status, "needs_resolution");
  assert.throws(() => prepareAttachment(db, { documentId: created.documentId, version: edited.version, format: "pdf", role: "resume" }), /not validated/, "the needs_resolution version itself is never attachable");
});

test("G5-1: template flag and section heading cannot smuggle a claim past validation", () => {
  const { db, personId, profileId } = setup();
  const base = buildResumeContent(db, personId, profileId, {});
  const flagged = { ...base, sections: [...base.sections, { heading: "Education", lines: [{ text: "PhD in Astrophysics — Invented University", refs: [], template: true }] }] };
  assert.equal(revalidateContent(db, personId, profileId, flagged).ok, false, "a client template flag never exempts a claim");
  const headed = { ...base, sections: [...base.sections, { heading: "PhD in Astrophysics — Invented University", lines: [] }] };
  assert.equal(revalidateContent(db, personId, profileId, headed).ok, false, "a claim in a heading never validates");
  const plain = { ...base, sections: [...base.sections, { heading: "Extra", lines: [{ text: "SAP", refs: [{ kind: "profile", field: "skills", value: ["SAP", "Excel"] }] }] }] };
  assert.equal(revalidateContent(db, personId, profileId, plain).ok, true, "a plain label heading stays valid");
});

test("G5-1: genuine doctorate with a matching history ref validates and attaches", () => {
  const { db, personId, profileId } = setup({
    education: [{ id: "edu-9", institution: "Real University", title: "PhD in Economics", start: "2016", end: "2020" }],
  });
  const content = buildResumeContent(db, personId, profileId, {});
  const created = createDocument(db, { personId, profileId, kind: "resume", content, gaps: content.gaps });
  assert.equal(created.status, "validated");
  const attached = prepareAttachment(db, { documentId: created.documentId, format: "pdf", role: "resume" });
  assert.equal(attached.status, "prepared");
  assert.equal(attached.portalReceipt, null);
});

// --- Defect 2: scope parsing ---------------------------------------------

test("G5-2: function words are never country codes; explicit country names win", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  declareFact(db, { personId, concept: "work_authorisation", scope: "BE", value: "no", provenance: "user" });
  const spain = resolveSemantic(db, personId, { text: "Would you be authorized to work in Spain?" });
  assert.equal(spain.scope, "ES");
  assert.equal(spain.value, "yes");
  const belgium = resolveSemantic(db, personId, { text: "Would you be authorized to work in Belgium?" });
  assert.equal(belgium.scope, "BE");
  assert.equal(belgium.value, "no");
  assert.equal(parseQuestionText("Would you be authorized to work in Spain?").scope, "ES");
  assert.equal(parseQuestionText("Do you want to be in Spain?").scope, "ES", "be/to/in as verbs never become codes");
  const code = resolveSemantic(db, personId, { text: "Are you authorized to work in BE?" });
  assert.equal(code.scope, "BE", "a genuinely uppercase code still resolves");
  assert.equal(code.value, "no");
  const aliases = listAliases(db, personId);
  assert.ok(aliases.some((a) => a.scope === "ES"), "no alias is stored under a mis-scoped resolution");
  assert.ok(!aliases.some((a) => a.variant_text.includes("Spain") && a.scope === "BE"), "Spain variant never aliased to Belgium");
});

// --- Defect 3: premise negation ------------------------------------------

test("G5-3: premise negation never leaks into the main question (and vice versa)", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  declareFact(db, { personId, concept: "sponsorship_required", scope: "ES", value: "no", provenance: "user" });
  const negPremise = resolveSemantic(db, personId, { text: "If you do not require sponsorship, are you authorized to work in Spain?", scope: "ES", premise: { concept: "sponsorship_required", scope: "ES", expected: "no" } });
  assert.equal(negPremise.kind, "declared");
  assert.equal(negPremise.value, "yes", "negative premise + positive question keeps yes");
  const negMain = resolveSemantic(db, personId, { text: "If you require sponsorship, are you not authorized to work in Spain?", scope: "ES", premise: { concept: "sponsorship_required", scope: "ES", expected: "no" } });
  assert.equal(negMain.kind, "declared");
  assert.equal(negMain.value, "no", "positive premise + negative question flips to no");
  const plain = resolveSemantic(db, personId, { text: "Are you not authorised to work in Spain?" });
  assert.equal(plain.value, "no", "plain negated paraphrase flips");
  const positive = resolveSemantic(db, personId, { text: "Are you authorized to work in Spain?" });
  assert.equal(positive.value, "yes");
});

// --- Defect 4: unknown end dates ------------------------------------------

test("G5-4: unknown end date renders Unknown, never Present, in ranges and documents", () => {
  assert.equal(formatDateRange({ start: "2020", end: null, current: false }), "2020 – Unknown");
  assert.equal(formatDateRange({ start: "2020", end: null }), "2020 – Unknown");
  assert.equal(formatDateRange({ start: "2020", end: null, current: true }), "2020 – Present");
  assert.equal(formatDateRange({ start: "2020", end: "2024" }), "2020 – 2024");
  assert.equal(formatDateRange({ start: "2020-01", end: null }), "January 2020 – Unknown", "partial precision + unknown end");
  const { db, personId, profileId } = setup({
    employment: [{ id: "job-9", employer: "Fixture Corp", title: "Accountant", start: "2020", end: null, current: false }],
    education: [{ id: "edu-9", institution: "Fixture University", title: "BSc Test Studies", start: "2016", end: null }],
  });
  const content = buildResumeContent(db, personId, profileId, {});
  const text = JSON.stringify(content.sections);
  assert.ok(!text.includes("Present"), "no generated sentence claims current employment from an unknown end");
  assert.ok(text.includes("2020 – Unknown"));
  assert.ok(text.includes("2016 – Unknown"), "education entries follow the same rule");
});

// --- Defect 5: PDF encoding + xref ----------------------------------------

test("G5-5: PDF extracts accented names and dashes exactly, with a strict-valid xref", async () => {
  const content = { title: "José Núñez — Resume", language: "en", sections: [{ heading: "Experience", lines: [{ text: "Accountant — Müller & Cía (2020 – 2024)", refs: [] }] }] };
  const pdf = renderPdf(content);
  const { text } = await pdfText(pdf);
  assert.ok(text.includes("José Núñez"), `pdf.js must extract the accented name, got: ${text}`);
  assert.ok(text.includes("Müller"), `pdf.js must extract the employer, got: ${text}`);
  assert.ok(text.includes("Cía"), `pdf.js must extract Cía, got: ${text}`);
  assert.ok(text.includes("—"), `em dashes must survive, got: ${text}`);
  assert.ok(text.includes("–"), `en dashes must survive, got: ${text}`);
  assertStrictXref(pdf);
  assert.deepEqual([...pdfEncodeText("—")], [0x97], "em dash maps to its WinAnsi byte");
  assert.deepEqual([...pdfEncodeText("ñ")], [0xf1], "ñ maps to its WinAnsi byte");
});

test("G5-5: long PDF still paginates with a strict-valid xref", async () => {
  const lines = Array.from({ length: 120 }, (_, i) => ({ text: `Repeated verifiable line ${i} for Fixture Corp`, refs: [] }));
  const pdf = renderPdf({ title: "Long", sections: [{ heading: "Experience", lines }] });
  const { text, pages } = await pdfText(pdf);
  assert.ok(pages > 1);
  assert.ok(text.includes("Repeated verifiable line 119"));
  assert.ok(text.includes("Page 1 of"));
  assertStrictXref(pdf);
});

// --- Defect 6: sensitive negation -----------------------------------------

test("G5-6: declared sensitive concepts follow the same negation semantics", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "veteran_status", scope: "", value: "yes", provenance: "user" });
  assert.equal(resolveSemantic(db, personId, { text: "Are you a veteran?" }).value, "yes");
  const negated = resolveSemantic(db, personId, { text: "Are you not a veteran?" });
  assert.equal(negated.kind, "declared");
  assert.equal(negated.value, "no", "negated sensitive question flips like the ordinary branch");
  const { db: db2, personId: person2 } = setup();
  const omitted = resolveSemantic(db2, person2, { text: "Are you not a veteran?" });
  assert.equal(omitted.kind, "voluntary_omitted", "no declaration/consent still omits, even when negated");
});

// --- Defect 7: alias evidence renewal --------------------------------------

test("G5-7: alias repeat after fact replacement references only the live fact", () => {
  const { db, personId } = setup();
  const f1 = declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  assert.equal(resolveSemantic(db, personId, { text: "Are you authorized to work in Spain?" }).value, "yes");
  db.prepare("DELETE FROM declared_facts WHERE id = ?").run(f1);
  const f2 = declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "no", provenance: "user" });
  const repeat = resolveSemantic(db, personId, { text: "Are you authorized to work in Spain?" });
  assert.ok(repeat.kind === "alias_stale" || !(repeat.references || []).includes(f1), "never a deleted fact's reference");
  if (repeat.kind === "declared") {
    assert.deepEqual(repeat.references, [f2], "fresh verified resolution references only the live fact");
    assert.equal(repeat.value, "no");
  }
  assert.equal(auditResolvedAnswers(db, personId, [repeat]).contamination, 0);
});

test("G5-7: alias goes stale when its evidence fact is deleted with no replacement", () => {
  const { db, personId } = setup();
  const f1 = declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  resolveSemantic(db, personId, { text: "Are you authorized to work in Spain?" });
  db.prepare("DELETE FROM declared_facts WHERE id = ?").run(f1);
  const repeat = resolveSemantic(db, personId, { text: "Are you authorized to work in Spain?" });
  assert.equal(repeat.kind, "alias_stale");
});
