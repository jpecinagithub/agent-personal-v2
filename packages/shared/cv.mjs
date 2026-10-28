// Pliego T-V2-016: CV importer. PDF, DOCX and plain text, with a preview
// step, extraction with provenance, and confirmation before the data
// becomes usable. RF-V2-012: each proposal keeps its document, page or
// section of origin and confidence; unapproved text never replaces
// confirmed facts.
// R1 (G2 re-review): proposals are IMMUTABLE PER IMPORT. A preview no
// longer writes shared mutable declared_facts rows — the old bug was
// that two previews upserted the same (person, concept, scope) row, so
// previewing B overwrote A's pending value and confirming A confirmed
// B's data. Now each import owns its cv_proposals rows; confirmation
// applies ONLY that import's proposals, and a proposal that conflicts
// with an already-confirmed fact is reported as a conflict and leaves
// the fact untouched unless the user explicitly resolves it to replace.
// Proposals can be corrected before confirming (the correction edits
// that import's own proposal row, never another import's data).
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
 * Extract text with per-page breakdown (for PDF provenance sections).
 * @param {Buffer} buffer
 * @param {"pdf" | "docx" | "txt"} format
 * @returns {Promise<{text: string, pages: {page: number, text: string}[]}>}
 */
export async function extractCvTextWithPages(buffer, format) {
  if (!buffer || buffer.length === 0) throw new Error("empty CV file: nothing to import");
  if (buffer.length > MAX_BYTES) throw new Error("CV file exceeds the 10 MB limit");
  if (format === "txt") {
    const text = buffer.toString("utf8").trim();
    if (!text) throw new Error("empty CV file: nothing to import");
    return { text, pages: [{ page: 1, text }] };
  }
  if (format === "pdf") {
    let doc;
    try {
      doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    } catch {
      throw new Error("corrupt PDF: the document cannot be parsed");
    }
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      // pdf.js marks end-of-line items with hasEOL: preserve line
      // breaks, otherwise the whole page collapses into one line and
      // the name/email/phone heuristics cannot tell lines apart.
      const pageText = content.items.map((/** @type {any} */ item) => item.str + (item.hasEOL ? "\n" : " ")).join("");
      pages.push({ page: i, text: pageText.replace(/[ \t]+/g, " ").trim() });
    }
    // A PDF with no text layer (scanned) yields no text: this is NOT an
    // error at preview time, it is a warning, and confirmation is
    // refused (see confirmCvImport). The caller distinguishes it by the
    // empty string + the scanned warning set in previewCv.
    return { text: pages.map((p) => p.text).join("\n").trim(), pages };
  }
  // docx
  try {
    const result = await mammoth.extractRawText({ buffer });
    const text = String(result.value ?? "").trim();
    if (!text) throw new Error("empty CV file: nothing to import");
    return { text, pages: [{ page: 1, text }] };
  } catch (err) {
    if (err instanceof Error && /empty CV file/.test(err.message)) throw err;
    throw new Error("corrupt DOCX: the document cannot be parsed");
  }
}

/**
 * Extract raw text from a CV buffer. Throws on corrupt or empty input.
 * @param {Buffer} buffer
 * @param {"pdf" | "docx" | "txt"} format
 * @returns {Promise<string>}
 */
export async function extractCvText(buffer, format) {
  return (await extractCvTextWithPages(buffer, format)).text;
}

/**
 * Heuristic candidate fields from extracted text, each with the page or
 * section it came from and a confidence. These are candidates for the
 * user to confirm, never facts on their own.
 * @param {string} text
 * @param {{page: number, text: string}[]} pages
 * @returns {{lines: string[], email: string | null, phone: string | null, nameGuess: string | null, proposals: {concept: string, value: string, section: string, confidence: number}[]}}
 */
export function extractCandidateFields(text, pages = [{ page: 1, text }]) {
  const lines = String(text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const email = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [])[0] ?? null;
  const phone = (text.match(/\+?\d[\d\s().-]{6,}\d/) || [])[0]?.trim() ?? null;
  const nameGuess = lines.find((l) => l !== email && l !== phone && !l.includes("@")) ?? null;
  const sectionOf = (value) => {
    if (!value) return "text";
    const found = pages.find((p) => p.text.includes(value));
    return found ? `page ${found.page}` : "text";
  };
  const proposals = [];
  if (email) proposals.push({ concept: "email", value: email, section: sectionOf(email), confidence: 0.95 });
  if (phone) proposals.push({ concept: "phone", value: phone, section: sectionOf(phone), confidence: 0.85 });
  if (nameGuess) proposals.push({ concept: "full_name", value: nameGuess, section: sectionOf(nameGuess), confidence: 0.6 });
  return { lines, email, phone, nameGuess, proposals };
}

/**
 * Preview step: validate, extract and store the import in "preview"
 * status, with its OWN proposal rows (never shared declared_facts
 * rows). Proposals never resolve answers until confirmed.
 * @param {any} db
 * @param {string} personId
 * @param {string} filename
 * @param {Buffer} buffer
 * @returns {Promise<{id: string, format: string, extractedText: string, candidates: any, proposals: any[], warning: string | null}>}
 */
export async function previewCv(db, personId, filename, buffer) {
  if (!db.prepare("SELECT id FROM persons WHERE id = ?").get(personId)) throw new Error("person not found");
  const format = detectFormat(filename, buffer);
  const { text: extractedText, pages } = await extractCvTextWithPages(buffer, format);
  const candidates = extractCandidateFields(extractedText, pages);
  const warning = format === "pdf" && !extractedText
    ? "scanned_no_text: this PDF has no text layer (scanned document); its content cannot be extracted and it can never be confirmed — enter the data manually instead"
    : null;
  const id = randomUUID();
  // The import row must exist first: cv_proposals.cv_import_id is a
  // foreign key to cv_imports(id).
  db.prepare(
    "INSERT INTO cv_imports (id, person_id, filename, format, extracted_text, candidate_fields_json, candidate_fact_ids_json, candidate_proposal_ids_json, warning, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'preview')",
  ).run(id, personId, filename, format, extractedText, JSON.stringify({ lines: candidates.lines, email: candidates.email, phone: candidates.phone, nameGuess: candidates.nameGuess }), "[]", "[]", warning);
  const proposalIds = [];
  const proposals = [];
  for (const proposal of candidates.proposals) {
    const proposalId = randomUUID();
    db.prepare(
      "INSERT INTO cv_proposals (id, cv_import_id, person_id, concept, scope, value_json, source_document, source_section, confidence, status) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, 'proposed')",
    ).run(proposalId, id, personId, proposal.concept, JSON.stringify(proposal.value), filename, proposal.section, proposal.confidence);
    proposalIds.push(proposalId);
    proposals.push({ id: proposalId, ...proposal, scope: "", status: "proposed" });
  }
  db.prepare("UPDATE cv_imports SET candidate_proposal_ids_json = ? WHERE id = ?").run(JSON.stringify(proposalIds), id);
  return { id, format, extractedText, candidates, proposals, warning };
}

/**
 * Proposals belonging to one import, in creation order.
 * @param {any} db
 * @param {string} cvImportId
 * @returns {any[]}
 */
export function listProposals(db, cvImportId) {
  return db.prepare("SELECT * FROM cv_proposals WHERE cv_import_id = ? ORDER BY created_at ASC, rowid ASC").all(cvImportId).map((r) => ({
    ...r, value: JSON.parse(r.value_json),
  }));
}

/**
 * Correct one proposal before confirming. The correction edits only
 * this import's own proposal row, never another import's data, and
 * only while the import is still in preview.
 * Belonging is validated BEFORE any write, and the update itself is
 * conditioned on both identifiers in a single statement: a rejected
 * cross-import correction (a proposal of import B corrected through
 * import A's URL) changes nothing anywhere.
 * @param {any} db
 * @param {string} proposalId
 * @param {unknown} value
 * @param {string} [expectedCvImportId] the import id from the request URL, when known
 * @returns {any}
 */
export function correctProposal(db, proposalId, value, expectedCvImportId) {
  const proposal = db.prepare("SELECT * FROM cv_proposals WHERE id = ?").get(proposalId);
  if (!proposal) throw new Error("proposal not found");
  if (expectedCvImportId !== undefined && proposal.cv_import_id !== expectedCvImportId) {
    throw new Error("proposal does not belong to this CV import");
  }
  const cv = db.prepare("SELECT status FROM cv_imports WHERE id = ?").get(proposal.cv_import_id);
  if (!cv || cv.status !== "preview") throw new Error("only proposals of a previewed CV can be corrected");
  if (value === undefined || value === null || String(value).trim() === "") throw new Error("corrected proposal value is required");
  const r = db.prepare("UPDATE cv_proposals SET value_json = ? WHERE id = ? AND cv_import_id = ?").run(JSON.stringify(value), proposalId, proposal.cv_import_id);
  if (r.changes === 0) throw new Error("proposal does not belong to this CV import");
  return { ...proposal, value };
}

/**
 * @param {any} db
 * @param {string} id
 * @returns {any | null}
 */
export function getCvImport(db, id) {
  const row = db.prepare("SELECT * FROM cv_imports WHERE id = ?").get(id);
  if (!row) return null;
  const candidates = JSON.parse(row.candidate_fields_json);
  return {
    ...row,
    candidates,
    candidateFactIds: JSON.parse(row.candidate_fact_ids_json),
    candidateProposalIds: JSON.parse(row.candidate_proposal_ids_json),
    proposals: listProposals(db, id),
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
    candidateProposalIds: JSON.parse(row.candidate_proposal_ids_json),
    proposals: listProposals(db, row.id),
  }));
}

/**
 * Confirm a previewed import: only possible with extractable text.
 * Applies ONLY this import's proposals. A proposal whose concept
 * already has a confirmed fact with a different value is NOT applied:
 * it is reported as a conflict and the confirmed fact is left
 * untouched, unless the caller explicitly resolves it with
 * resolutions[proposalId] = "replace" (overwrite) or "keep" (skip).
 * An import whose proposals all apply is "confirmed"; one with
 * unresolved conflicts is "confirmed_with_conflicts" and can be
 * re-confirmed later to resolve the remaining conflicts explicitly.
 * @param {any} db
 * @param {string} id
 * @param {{resolutions?: Record<string, string>}} [opts]
 * @returns {{id: string, status: string, applied: string[], conflicts: {proposalId: string, concept: string, existing: unknown, proposed: unknown}[], skipped: string[]}}
 */
export function confirmCvImport(db, id, opts = {}) {
  const cv = getCvImport(db, id);
  if (!cv) throw new Error("CV import not found");
  if (cv.status !== "preview" && cv.status !== "confirmed_with_conflicts") {
    throw new Error(`only a previewed CV can be confirmed (status: ${cv.status})`);
  }
  if (!cv.extracted_text || !cv.extracted_text.trim()) {
    throw new Error("cannot confirm a CV with no extractable text (scanned document needs manual entry)");
  }
  const resolutions = opts.resolutions ?? {};
  const applied = [];
  const conflicts = [];
  const skipped = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const proposal of cv.proposals) {
      if (proposal.status === "applied" || proposal.status === "skipped") continue;
      const existing = getConfirmedFact(db, cv.person_id, proposal.concept, proposal.scope ?? "");
      if (existing && JSON.stringify(existing.value) !== JSON.stringify(proposal.value)) {
        const decision = resolutions[proposal.id];
        if (decision === "replace") {
          declareFact(db, { personId: cv.person_id, concept: proposal.concept, scope: proposal.scope ?? "", value: proposal.value, provenance: "cv-import" });
          db.prepare("UPDATE cv_proposals SET status = 'applied' WHERE id = ?").run(proposal.id);
          applied.push(proposal.id);
        } else if (decision === "keep") {
          db.prepare("UPDATE cv_proposals SET status = 'skipped' WHERE id = ?").run(proposal.id);
          skipped.push(proposal.id);
        } else {
          db.prepare("UPDATE cv_proposals SET status = 'conflicted' WHERE id = ?").run(proposal.id);
          conflicts.push({ proposalId: proposal.id, concept: proposal.concept, existing: existing.value, proposed: proposal.value });
        }
        continue;
      }
      // No confirmed fact, or the same value: applying is a no-op for
      // the fact itself when equal, and an insert when absent.
      if (!existing) {
        declareFact(db, { personId: cv.person_id, concept: proposal.concept, scope: proposal.scope ?? "", value: proposal.value, provenance: "cv-import" });
      }
      db.prepare("UPDATE cv_proposals SET status = 'applied' WHERE id = ?").run(proposal.id);
      applied.push(proposal.id);
    }
    // A re-confirmation of a conflicted import only touches its
    // conflicted proposals; proposals already applied or skipped stay.
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM cv_proposals WHERE cv_import_id = ? AND status = 'conflicted'").get(id).n;
    const status = remaining > 0 ? "confirmed_with_conflicts" : "confirmed";
    db.prepare("UPDATE cv_imports SET status = ?, confirmed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(status, id);
    db.exec("COMMIT");
    return { id, status, applied, conflicts, skipped };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
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
  db.prepare("UPDATE cv_proposals SET status = 'rejected' WHERE cv_import_id = ? AND status = 'proposed'").run(id);
  return { id, status: "rejected" };
}

/**
 * A person has a validated CV when at least one import is fully
 * confirmed. An import with unresolved conflicts is NOT validated:
 * it may be selected for a profile, but it does not satisfy readiness
 * and cannot enter an attempt until its conflicts are resolved.
 * (Person-level helper kept for compatibility; readiness is per-profile,
 * see profiles.mjs profileCvValidated.)
 * @param {any} db
 * @param {string} personId
 * @returns {boolean}
 */
export function hasValidatedCv(db, personId) {
  return db.prepare("SELECT COUNT(*) AS n FROM cv_imports WHERE person_id = ? AND status = 'confirmed'").get(personId).n > 0;
}

/**
 * The CV import a profile has explicitly selected, if it is fully
 * confirmed. A conflicted import is deliberately NOT validated here:
 * readiness and attempt creation require a resolved CV.
 * @param {any} db
 * @param {string} cvImportId
 * @returns {any | null}
 */
export function getValidatedCvImport(db, cvImportId) {
  if (!cvImportId) return null;
  const cv = getCvImport(db, cvImportId);
  if (!cv || cv.status !== "confirmed") return null;
  return cv;
}

/**
 * The CV import a profile may SELECT: fully confirmed, or confirmed
 * with unresolved conflicts. Selection is not validation: assigning a
 * conflicted CV is allowed so the user can see and resolve it, but
 * readiness still blocks until every conflict is resolved explicitly.
 * A previewed, rejected or foreign import can never be selected.
 * @param {any} db
 * @param {string} cvImportId
 * @returns {any | null}
 */
export function getProfileCvImport(db, cvImportId) {
  if (!cvImportId) return null;
  const cv = getCvImport(db, cvImportId);
  if (!cv || (cv.status !== "confirmed" && cv.status !== "confirmed_with_conflicts")) return null;
  return cv;
}
