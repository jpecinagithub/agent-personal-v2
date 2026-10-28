// Pliego T-V2-016: CV importer. PDF, DOCX and plain text, with a preview
// step, extraction with provenance, and confirmation before the data
// becomes usable. Extracted candidate facts are stored with provenance
// "cv-import" in "pending" confirmation state; only the confirm step
// makes them confirmed and the CV validated. A corrupt or empty file is
// never approved. A PDF with no text layer (a scanned document) is
// reported in the preview with a warning and can never be confirmed:
// the user must enter that data manually instead of the importer
// silently approving an empty CV.
// Parsing libraries are used deliberately: the stdlib cannot parse PDF
// or DOCX. pdfjs-dist (modern pdf.js) for PDF, mammoth for DOCX.
// NOTE: pdf-parse 1.1.1 was tried first and rejected: its index runs a
// debug snippet on import, and its bundled pdf.js (v1.10, 2017) cannot
// read PDFs produced by modern writers ("bad XRef entry" / "Invalid PDF
// structure"). pdfjs-dist 4 extracts the same fixtures correctly.
import { randomUUID } from "node:crypto";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth";
import { declareFact, getConfirmedFact } from "./facts.mjs";

const MAX_BYTES = 10 * 1024 * 1024;

/**
 * Detect the CV format from the filename and the first bytes.
 * @param {string} filename
 * @param {Buffer} buffer
 * @returns {"pdf" | "docx" | "txt"}
 */
export function detectFormat(filename, buffer) {
  const lower = String(filename ?? "").toLowerCase();
  if (buffer.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (buffer.subarray(0, 2).toString("latin1") === "PK") return "docx";
  if (lower.endsWith(".pdf")) throw new Error("corrupt PDF: file does not start with %PDF");
  if (lower.endsWith(".docx")) throw new Error("corrupt DOCX: file is not a ZIP archive");
  if (lower.endsWith(".txt") || lower === "") return "txt";
  throw new Error(`unsupported CV file type: ${filename}`);
}

/**
 * Extract raw text from a CV buffer. Throws on corrupt or empty input.
 * @param {Buffer} buffer
 * @param {"pdf" | "docx" | "txt"} format
 * @returns {Promise<string>}
 */
export async function extractCvText(buffer, format) {
  if (!buffer || buffer.length === 0) throw new Error("empty CV file: nothing to import");
  if (buffer.length > MAX_BYTES) throw new Error("CV file exceeds the 10 MB limit");
  if (format === "txt") {
    const text = buffer.toString("utf8").trim();
    if (!text) throw new Error("empty CV file: nothing to import");
    return text;
  }
  if (format === "pdf") {
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    } catch {
      throw new Error("corrupt PDF: the document cannot be parsed");
    }
    const parts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // pdf.js marks end-of-line items with hasEOL: preserve line
      // breaks, otherwise the whole page collapses into one line and
      // the name/email/phone heuristics in extractCandidateFields
      // cannot tell the lines apart.
      parts.push(content.items.map((/** @type {any} */ item) => item.str + (item.hasEOL ? "\n" : " ")).join(""));
    }
    // A PDF with no text layer (scanned) yields no text: this is NOT an
    // error at preview time, it is a warning, and confirmation is
    // refused (see confirmCvImport). The caller distinguishes it by the
    // empty string + the scanned warning set in previewCv.
    return parts.join("\n").replace(/[ \t]+/g, " ").trim();
  }
  // docx
  try {
    const result = await mammoth.extractRawText({ buffer });
    const text = String(result.value ?? "").trim();
    if (!text) throw new Error("empty CV file: nothing to import");
    return text;
  } catch (err) {
    if (err instanceof Error && /empty CV file/.test(err.message)) throw err;
    throw new Error("corrupt DOCX: the document cannot be parsed");
  }
}

/**
 * Heuristic candidate fields from extracted text. These are candidates
 * for the user to confirm, never facts on their own.
 * @param {string} text
 * @returns {{lines: string[], email: string | null, phone: string | null, nameGuess: string | null}}
 */
export function extractCandidateFields(text) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const email = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0] ?? null;
  const phone = (text.match(/\+?\d[\d\s().-]{6,}\d/) || [])[0]?.trim() ?? null;
  const nameGuess = lines.find((l) => l !== email && l !== phone && !l.includes("@")) ?? null;
  return { lines, email, phone, nameGuess };
}

/**
 * Preview step: validate, extract and store the import in "preview"
 * status, with its candidate facts in "pending" state (they never
 * resolve answers until confirmed).
 * @param {any} db
 * @param {string} personId
 * @param {string} filename
 * @param {Buffer} buffer
 * @returns {Promise<{id: string, format: string, extractedText: string, candidates: ReturnType<typeof extractCandidateFields>, warning: string | null}>}
 */
export async function previewCv(db, personId, filename, buffer) {
  if (!db.prepare("SELECT id FROM persons WHERE id = ?").get(personId)) throw new Error("person not found");
  const format = detectFormat(filename, buffer);
  const extractedText = await extractCvText(buffer, format);
  const candidates = extractCandidateFields(extractedText);
  const warning = format === "pdf" && !extractedText
    ? "scanned_no_text: this PDF has no text layer (scanned document); its content cannot be extracted and it can never be confirmed — enter the data manually instead"
    : null;
  const id = randomUUID();
  const factIds = [];
  const pending = [
    ["email", candidates.email],
    ["phone", candidates.phone],
    ["full_name", candidates.nameGuess],
  ];
  for (const [concept, value] of pending) {
    if (!value) continue;
    // Never downgrade a confirmed fact back to pending: a second preview
    // must not un-confirm what an earlier confirmed CV established.
    if (getConfirmedFact(db, personId, concept, "")) continue;
    factIds.push(declareFact(db, { personId, concept, scope: "", value, provenance: "cv-import", confirmationState: "pending" }));
  }
  db.prepare(
    "INSERT INTO cv_imports (id, person_id, filename, format, extracted_text, candidate_fields_json, candidate_fact_ids_json, warning, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preview')",
  ).run(id, personId, filename, format, extractedText, JSON.stringify(candidates), JSON.stringify(factIds), warning);
  return { id, format, extractedText, candidates, warning };
}

/**
 * @param {any} db
 * @param {string} id
 * @returns {any | null}
 */
export function getCvImport(db, id) {
  const row = db.prepare("SELECT * FROM cv_imports WHERE id = ?").get(id);
  if (!row) return null;
  return {
    ...row,
    candidates: JSON.parse(row.candidate_fields_json),
    candidateFactIds: JSON.parse(row.candidate_fact_ids_json),
  };
}

/**
 * @param {any} db
 * @param {string} personId
 * @returns {any[]}
 */
export function listCvImports(db, personId) {
  return db.prepare("SELECT * FROM cv_imports WHERE person_id = ? ORDER BY created_at ASC").all(personId).map((/** @type {any} */ row) => ({
    ...row,
    candidates: JSON.parse(row.candidate_fields_json),
    candidateFactIds: JSON.parse(row.candidate_fact_ids_json),
  }));
}

/**
 * Confirm a previewed import: only possible with extractable text.
 * Marks the CV validated and confirms its candidate facts.
 * @param {any} db
 * @param {string} id
 * @returns {{id: string, status: string}}
 */
export function confirmCvImport(db, id) {
  const cv = getCvImport(db, id);
  if (!cv) throw new Error("CV import not found");
  if (cv.status !== "preview") throw new Error(`only a previewed CV can be confirmed (status: ${cv.status})`);
  if (!cv.extracted_text || !cv.extracted_text.trim()) {
    throw new Error("cannot confirm a CV with no extractable text (scanned document needs manual entry)");
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const factId of cv.candidateFactIds) {
      db.prepare("UPDATE declared_facts SET confirmation_state = 'confirmed' WHERE id = ?").run(factId);
    }
    db.prepare("UPDATE cv_imports SET status = 'confirmed', confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
  return { id, status: "confirmed" };
}

/**
 * @param {any} db
 * @param {string} id
 * @returns {{id: string, status: string}}
 */
export function rejectCvImport(db, id) {
  const cv = getCvImport(db, id);
  if (!cv) throw new Error("CV import not found");
  if (cv.status !== "preview") throw new Error(`only a previewed CV can be rejected (status: ${cv.status})`);
  db.prepare("UPDATE cv_imports SET status = 'rejected' WHERE id = ?").run(id);
  return { id, status: "rejected" };
}

/**
 * A person has a validated CV when at least one import is confirmed.
 * @param {any} db
 * @param {string} personId
 * @returns {boolean}
 */
export function hasValidatedCv(db, personId) {
  return db.prepare("SELECT COUNT(*) AS n FROM cv_imports WHERE person_id = ? AND status = 'confirmed'").get(personId).n > 0;
}
