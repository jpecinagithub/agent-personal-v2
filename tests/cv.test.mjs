// Pliego T-V2-016: CV importer (PDF/DOCX/text) with preview, extraction
// with provenance, and confirmation. Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import { previewCv, confirmCvImport, rejectCvImport, getCvImport, listCvImports, hasValidatedCv } from "../packages/shared/cv.mjs";
import { listFacts } from "../packages/shared/facts.mjs";
import { resolveScreening } from "../packages/shared/resolve.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-cv-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, FIXTURE_PERSON);
  return { db, personId };
}

function fixture(name) {
  return fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url).pathname);
}

for (const [name, file] of [["PDF", "sample.pdf"], ["DOCX", "sample.docx"], ["texto", "sample.txt"]]) {
  test(`importador ${name}: la vista previa devuelve el texto conocido y los hechos quedan pendientes hasta confirmar`, async () => {
    const { db, personId } = setup();
    const preview = await previewCv(db, personId, file, fixture(file));
    assert.ok(preview.extractedText.includes("Test Person"), "preview must contain the known name");
    assert.ok(preview.extractedText.includes("test.person@example.test"), "preview must contain the known email");
    assert.equal(preview.candidates.email, "test.person@example.test");
    assert.equal(preview.candidates.nameGuess, "Test Person");
    assert.equal(preview.warning, null);
    const stored = getCvImport(db, preview.id);
    assert.equal(stored.status, "preview");
    // R1: a preview creates NO shared fact rows at all — only its own
    // proposal rows, which never resolve answers until confirmed.
    const facts = listFacts(db, personId).filter((f) => f.provenance === "cv-import");
    assert.equal(facts.length, 0, "a preview must not write declared facts");
    assert.ok(stored.proposals.length >= 1, "preview must own its proposals");
    assert.ok(stored.proposals.every((p) => p.status === "proposed"), "proposals start proposed");
    assert.ok(stored.proposals.every((p) => p.source_document && p.confidence > 0), "proposals carry provenance and confidence");
    const answers = resolveScreening(db, personId, [{ concept: "email", scope: "" }]);
    assert.equal(answers[0].kind, "missing", "a proposal must not answer screening");
    assert.equal(hasValidatedCv(db, personId), false);
    const confirmed = confirmCvImport(db, preview.id);
    assert.equal(confirmed.status, "confirmed");
    assert.equal(hasValidatedCv(db, personId), true);
    const factsAfter = listFacts(db, personId).filter((f) => f.provenance === "cv-import");
    assert.ok(factsAfter.length >= 1);
    assert.ok(factsAfter.every((f) => f.confirmation_state === "confirmed"));
    const answersAfter = resolveScreening(db, personId, [{ concept: "email", scope: "" }]);
    assert.equal(answersAfter[0].kind, "declared");
    assert.equal(answersAfter[0].value, "test.person@example.test");
  });
}

test("archivo corrupto o vacío nunca se aprueba", async () => {
  const { db, personId } = setup();
  await assert.rejects(() => previewCv(db, personId, "cv.pdf", Buffer.from("this is not a pdf")), /corrupt PDF/);
  await assert.rejects(() => previewCv(db, personId, "cv.txt", Buffer.from("")), /empty CV file/);
  await assert.rejects(() => previewCv(db, personId, "cv.txt", Buffer.from("   \n  ")), /empty CV file/);
  await assert.rejects(() => previewCv(db, personId, "cv.docx", Buffer.from("PK\x03\x04garbagegarbage")), /corrupt DOCX/);
  assert.equal(listCvImports(db, personId).length, 0, "no failed import may leave a record behind");
});

test("PDF escaneado sin texto: vista previa con aviso y confirmación rechazada", async () => {
  const { db, personId } = setup();
  // A valid PDF whose page has no text at all (the scanned-document case).
  const preview = await previewCv(db, personId, "scan.pdf", fixture("scanned.pdf"));
  assert.ok(preview.warning && preview.warning.startsWith("scanned_no_text"), "scanned PDF must be flagged in the preview");
  assert.equal(preview.extractedText, "");
  assert.throws(() => confirmCvImport(db, preview.id), /no extractable text/);
  assert.equal(hasValidatedCv(db, personId), false, "a scanned CV must never count as validated");
});

test("rechazar una importación no la valida ni confirma sus hechos", async () => {
  const { db, personId } = setup();
  const preview = await previewCv(db, personId, "sample.txt", fixture("sample.txt"));
  const rejected = rejectCvImport(db, preview.id);
  assert.equal(rejected.status, "rejected");
  assert.equal(hasValidatedCv(db, personId), false);
  assert.throws(() => confirmCvImport(db, preview.id), /only a previewed CV/);
});
