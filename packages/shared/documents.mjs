// F5 T-V2-044, T-V2-045, T-V2-046, T-V2-047 (RF-V2-019, 056, 057,
// 058, 059, 060, 061): canonical English documents from declared
// material only, common PDF/DOCX rendering, append-only versions with
// revalidation and snapshots, and portal attachment preparation.
// Hard rules, enforced here and not downstream:
//  - UI/help are Spanish; resume, cover letter and answers are ENGLISH
//    only (content.language is always "en"; an edit in another
//    language fails revalidation);
//  - ZERO invented facts: every claim line carries references to a
//    retained source (a master-history entry id, a profile/person
//    field with its current value, or a confirmed declared fact id).
//    Gaps are reported SEPARATELY and never appear as claims — a
//    missing phone, skill or company is omitted, never filled with a
//    plausible value;
//  - official titles and dates are preserved exactly as stored, at
//    the precision held (year or year-month; a day is never invented);
//  - versions are append-only: an edit creates a new version with a
//    fresh snapshot; old versions are never rewritten;
//  - F5 generates and previews documents only. Nothing here creates
//    attempts, queue candidates or final actions, and an attachment
//    marked "prepared" is NOT portal receipt: a hash alone never
//    proves the portal received the file (RF-V2-060).
import { randomUUID, createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { getPerson } from "./person.mjs";
import {
  getProfileFull, assertProfileBelongsToPerson, presentedHistory, pinSnapshot,
} from "./profiles.mjs";
import { listFacts } from "./facts.mjs";
import { formatDateRange } from "./semantic.mjs";

const MAX_ATTACHMENT_BYTES_DEFAULT = 5_000_000;
const FORMAT_MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const KIND_ROLE = { resume: "resume", cover_letter: "cover_letter" };

function isNonEmptyString(v) { return typeof v === "string" && v.trim() !== ""; }
function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

/** A claim line: text plus the retained sources backing every assertion in it. */
function line(text, refs = [], extra = {}) {
  return { text, refs, ...extra };
}
/** Template phrasing (greeting, generic closing): letter furniture, not a personal claim. */
function templateLine(text) {
  return { text, refs: [], template: true };
}

function contactLines(details) {
  const lines = [];
  if (isNonEmptyString(details.email)) lines.push(line(details.email, [{ kind: "person", field: "email", value: details.email }]));
  if (isNonEmptyString(details.phone)) lines.push(line(details.phone, [{ kind: "person", field: "phone", value: details.phone }]));
  return lines;
}

/**
 * Build the canonical ENGLISH resume for a profile. Emphasis/order
 * adapt to the profile (its desired roles first, its skills, its
 * presented history in master order); official titles and stored
 * dates are preserved exactly. Gaps are returned separately and never
 * written into the document.
 */
export function buildResumeContent(db, personId, profileId, { company = "", role = "" } = {}) {
  const person = getPerson(db, personId);
  if (!person) throw new Error("person not found");
  const profile = assertProfileBelongsToPerson(db, personId, profileId);
  const details = person.details;
  const body = profile.body ?? {};
  const history = presentedHistory(details, body);
  const gaps = [];
  const sections = [];
  sections.push({
    heading: details.full_name,
    lines: [
      ...(isNonEmptyString(role) ? [line(role, [{ kind: "profile", field: "desired_roles", value: body.desired_roles ?? [] }])] : []),
      ...(Array.isArray(body.desired_roles) && body.desired_roles.length > 0
        ? body.desired_roles.map((r) => line(r, [{ kind: "profile", field: "desired_roles", value: body.desired_roles }]))
        : []),
      ...contactLines(details),
    ],
  });
  if (!details.email && !details.phone) gaps.push("no contact method stored: email and phone both absent");
  if (Array.isArray(body.skills) && body.skills.length > 0) {
    sections.push({ heading: "Skills", lines: body.skills.map((s) => line(s, [{ kind: "profile", field: "skills", value: body.skills }])) });
  } else gaps.push("no skills stored on the profile");
  if (history.employment.length > 0) {
    sections.push({
      heading: "Experience",
      lines: history.employment.map((e) => line(
        `${e.title ?? ""}${e.employer ? ` — ${e.employer}` : ""} (${formatDateRange(e)})`.trim(),
        [{ kind: "history", entryKind: "employment", id: e.id, value: { title: e.title, employer: e.employer, start: e.start, end: e.end } }],
      )),
    });
  } else gaps.push("no employment history presented by this profile");
  if (history.education.length > 0) {
    sections.push({
      heading: "Education",
      lines: history.education.map((e) => line(
        `${e.title ?? ""}${e.institution ? ` — ${e.institution}` : ""} (${formatDateRange(e)})`.trim(),
        [{ kind: "history", entryKind: "education", id: e.id, value: { title: e.title, institution: e.institution, start: e.start, end: e.end } }],
      )),
    });
  } else gaps.push("no education history presented by this profile");
  if (Array.isArray(details.languages) && details.languages.length > 0) {
    sections.push({
      heading: "Languages",
      lines: details.languages.map((l) => line(`${l.language}: ${l.level}`, [{ kind: "person", field: "languages", value: details.languages }])),
    });
  }
  if (isNonEmptyString(company)) {
    sections[0].lines.unshift(templateLine(`Target company: ${company}`));
  }
  return {
    kind: "resume", language: "en", title: `${details.full_name} — Resume`,
    profileName: profile.name, company: company || null, role: role || null,
    sections, gaps,
  };
}

/**
 * Build the canonical ENGLISH cover letter for a company/role. Every
 * argument is verifiable: it cites presented employment, skills or
 * education only. Company/role are used only when supplied; a missing
 * company is never invented (generic addressee instead).
 */
export function buildCoverLetterContent(db, personId, profileId, { company = "", role = "" } = {}) {
  const person = getPerson(db, personId);
  if (!person) throw new Error("person not found");
  const profile = assertProfileBelongsToPerson(db, personId, profileId);
  const details = person.details;
  const body = profile.body ?? {};
  const history = presentedHistory(details, body);
  const gaps = [];
  if (!company) gaps.push("no target company supplied: letter uses a generic addressee");
  if (!role && !(Array.isArray(body.desired_roles) && body.desired_roles.length > 0)) gaps.push("no target role supplied and no desired roles on the profile");
  const targetRole = role || (body.desired_roles?.[0] ?? "");
  const lines = [];
  lines.push(templateLine(`Dear ${company ? `${company} Hiring Team` : "Hiring Team"},`));
  lines.push(templateLine(
    targetRole
      ? `I am writing to express my interest in the ${targetRole} position${company ? ` at ${company}` : ""}.`
      : "I am writing to express my interest in a position matching my profile.",
  ));
  const argRefs = [];
  const args = [];
  for (const e of history.employment.slice(0, 2)) {
    args.push(`My experience as ${e.title ?? "a professional"}${e.employer ? ` at ${e.employer}` : ""} (${formatDateRange(e)}) is directly relevant to this role.`);
    argRefs.push([{ kind: "history", entryKind: "employment", id: e.id, value: { title: e.title, employer: e.employer, start: e.start, end: e.end } }]);
  }
  if (Array.isArray(body.skills) && body.skills.length > 0) {
    args.push(`My skills include ${body.skills.join(", ")}.`);
    argRefs.push([{ kind: "profile", field: "skills", value: body.skills }]);
  }
  if (history.education.length > 0) {
    const e = history.education[0];
    args.push(`My education includes ${e.title ?? ""}${e.institution ? ` at ${e.institution}` : ""}.`);
    argRefs.push([{ kind: "history", entryKind: "education", id: e.id, value: { title: e.title, institution: e.institution, start: e.start, end: e.end } }]);
  }
  if (args.length === 0) gaps.push("no verifiable arguments available: letter contains no personal claims");
  args.forEach((text, i) => lines.push(line(text, argRefs[i])));
  lines.push(templateLine("I would welcome the opportunity to discuss how my background fits this position."));
  lines.push(templateLine(`Sincerely, ${details.full_name}`));
  return {
    kind: "cover_letter", language: "en", title: `${details.full_name} — Cover Letter`,
    profileName: profile.name, company: company || null, role: role || null,
    sections: [{ heading: "", lines }], gaps,
  };
}

// --- Revalidation (T-V2-046 / RF-V2-059) --------------------------------

/**
 * Genuine system template furniture (cover-letter greeting, generic
 * interest/closing sentences, target-company line). ONLY text matching
 * one of these patterns may skip reference validation via the
 * template flag. A client-supplied line flagged `template: true` with
 * any other text is treated as an ordinary claim: the flag never
 * exempts arbitrary client content from validation.
 */
const SYSTEM_TEMPLATE_PATTERNS = [
  /^Dear .* Hiring Team,$/,
  /^I am writing to express my interest in /,
  /^I would welcome the opportunity to discuss /,
  /^Sincerely, /,
  /^Target company: /,
];

function isSystemTemplate(text) {
  return SYSTEM_TEMPLATE_PATTERNS.some((re) => re.test(String(text ?? "").trim()));
}

const EDUCATION_LEVEL_KEYS = ["phd", "doctorate", "doctoral", "master", "masters", "mba", "msc", "bachelor", "bachelors", "bsc", "ba", "degree", "diploma"];

function claimWords(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
}

function claimLevels(text) {
  const words = new Set(claimWords(text));
  return new Set(EDUCATION_LEVEL_KEYS.filter((k) => words.has(k)));
}

function isEducationClaim(text) {
  const words = new Set(claimWords(text));
  if (EDUCATION_LEVEL_KEYS.some((k) => words.has(k))) return true;
  return ["university", "college", "institute", "school"].some((w) => words.has(w));
}

function significantTokens(text) {
  const stop = new Set(["university", "college", "institute", "school", "of", "the", "and", "de", "la"]);
  return new Set(claimWords(text).filter((w) => w.length >= 4 && !stop.has(w)));
}

/**
 * Does one reference actually SUPPORT an education claim (not merely
 * exist)? A history education entry supports it when its level matches
 * the claimed level, or its title/institution shares a significant
 * token with the claim. A highest_education fact supports it when its
 * value shares a level or a significant token. A skills ref, an
 * employment ref, or any unrelated fact never supports an education
 * claim, however the client flags the line.
 */
function educationRefSupports(db, personId, ref, claimText) {
  const levels = claimLevels(claimText);
  const tokens = significantTokens(claimText);
  const overlaps = (a, b) => [...a].some((t) => b.has(t));
  if (ref.kind === "history" && ref.entryKind === "education") {
    const entry = ref.value ?? (() => {
      const person = getPerson(db, personId);
      return (person?.details?.education ?? []).find((e) => e.id === ref.id);
    })();
    if (!entry) return false;
    if (overlaps(claimLevels(entry.title ?? ""), levels)) return true;
    if (overlaps(significantTokens(entry.title ?? ""), tokens)) return true;
    if (overlaps(significantTokens(entry.institution ?? ""), tokens)) return true;
    return false;
  }
  if (ref.kind === "fact") {
    const row = db.prepare("SELECT * FROM declared_facts WHERE id = ? AND person_id = ? AND confirmation_state = 'confirmed'").get(ref.id, personId);
    if (!row || row.concept !== "highest_education") return false;
    let value;
    try { value = JSON.parse(row.value_json); } catch { return false; }
    const valueText = typeof value === "string" ? value : JSON.stringify(value);
    if (overlaps(claimLevels(valueText), levels)) return true;
    if (overlaps(significantTokens(valueText), tokens)) return true;
    return false;
  }
  return false;
}

/**
 * Does one history reference's entry actually appear in the claim
 * text (title, employer or institution)? Generated lines always name
 * the entry; a line that names none of them is not backed by that ref.
 */
function historyRefMatchesText(db, personId, ref, claimText) {
  const entry = ref.value ?? (() => {
    const person = getPerson(db, personId);
    const list = ref.entryKind === "education" ? (person?.details?.education ?? []) : (person?.details?.employment ?? []);
    return list.find((e) => e.id === ref.id);
  })();
  if (!entry) return false;
  const text = String(claimText ?? "").toLowerCase();
  const fields = ref.entryKind === "education" ? [entry.title, entry.institution] : [entry.title, entry.employer];
  return fields.some((f) => isNonEmptyString(f) && text.includes(String(f).toLowerCase()));
}

/** Check one stored reference against the current retained set. */
export function checkRef(db, personId, profileId, ref) {
  if (!ref || typeof ref !== "object") return "reference is not an object";
  if (ref.kind === "fact") {
    const row = db.prepare("SELECT * FROM declared_facts WHERE id = ? AND person_id = ? AND confirmation_state = 'confirmed'").get(ref.id, personId);
    if (!row) return `fact ${ref.id} is not a confirmed declared fact`;
    let value;
    try { value = JSON.parse(row.value_json); } catch { return `fact ${ref.id} has unreadable stored value`; }
    if (ref.value !== undefined && !deepEqual(value, ref.value)) return `fact ${ref.id} value changed since the document version`;
    return null;
  }
  if (ref.kind === "history") {
    const person = getPerson(db, personId);
    if (!person) return "person not found";
    const list = ref.entryKind === "education" ? (person.details.education ?? []) : (person.details.employment ?? []);
    const entry = list.find((e) => e.id === ref.id);
    if (!entry) return `history entry ${ref.id} no longer exists`;
    if (ref.value) {
      const current = ref.entryKind === "education"
        ? { title: entry.title, institution: entry.institution, start: entry.start, end: entry.end }
        : { title: entry.title, employer: entry.employer, start: entry.start, end: entry.end };
      if (!deepEqual(current, ref.value)) return `history entry ${ref.id} changed since the document version`;
    }
    return null;
  }
  if (ref.kind === "profile") {
    const profile = getProfileFull(db, profileId);
    if (!profile) return "profile not found";
    if (ref.value !== undefined && !deepEqual(profile.body?.[ref.field], ref.value)) return `profile field ${ref.field} changed since the document version`;
    return null;
  }
  if (ref.kind === "person") {
    const person = getPerson(db, personId);
    if (!person) return "person not found";
    if (ref.value !== undefined && !deepEqual(person.details?.[ref.field], ref.value)) return `person field ${ref.field} changed since the document version`;
    return null;
  }
  return `unknown reference kind: ${ref.kind}`;
}

/**
 * Revalidate edited content before it becomes a version: language
 * must be English, every non-template line must carry references, and
 * every reference must still hold against the retained set. Returns
 * { ok, conflicts[] }; a conflicting edit is stored as
 * "needs_resolution", never as validated.
 */
export function revalidateContent(db, personId, profileId, content) {
  const conflicts = [];
  if (!content || typeof content !== "object") return { ok: false, conflicts: ["content is not an object"] };
  if (content.language !== "en") conflicts.push("document language must be English (en)");
  if (!Array.isArray(content.sections)) conflicts.push("content.sections must be an array");
  else {
    const person = getPerson(db, personId);
    for (const section of content.sections) {
      // A heading carries no references, so a heading that itself
      // STATES a claim can never validate — but a plain label
      // ("Extra", "Skills") is not a claim. Only claim-like headings
      // (an education claim, or a history entry's title + employer /
      // institution) are conflicts.
      if (typeof section.heading === "string" && section.heading.trim() !== "") {
        const heading = section.heading;
        const historyEntries = [
          ...(person?.details?.employment ?? []).map((e) => ({ title: e.title, org: e.employer })),
          ...(person?.details?.education ?? []).map((e) => ({ title: e.title, org: e.institution })),
        ];
        const headingStatesHistory = historyEntries.some((e) => isNonEmptyString(e.title) && isNonEmptyString(e.org)
          && heading.toLowerCase().includes(String(e.title).toLowerCase())
          && heading.toLowerCase().includes(String(e.org).toLowerCase()));
        if (isEducationClaim(heading) || headingStatesHistory) {
          conflicts.push(`section heading states a claim but carries no references: "${String(heading).slice(0, 80)}"`);
        }
      }
      if (!Array.isArray(section.lines)) { conflicts.push("section lines must be an array"); continue; }
      for (const l of section.lines) {
        // Template exemption applies ONLY to genuine system furniture.
        // Any other template-flagged line is validated as a claim.
        if (l.template && isSystemTemplate(l.text)) continue;
        if (!Array.isArray(l.refs) || l.refs.length === 0) {
          conflicts.push(`unreferenced claim: "${String(l.text ?? "").slice(0, 80)}"`);
          continue;
        }
        for (const ref of l.refs) {
          const problem = checkRef(db, personId, profileId, ref);
          if (problem) conflicts.push(problem);
        }
        // Claim-to-support: a reference must actually support the
        // claim, not merely exist. An education claim needs an
        // education reference matching its level/institution/title;
        // an unrelated skill (or any other fact type) never supports
        // it. A history-backed line must name its entry.
        if (isEducationClaim(l.text)) {
          const supported = l.refs.some((ref) => educationRefSupports(db, personId, ref, l.text));
          if (!supported) conflicts.push(`education claim not supported by its references: "${String(l.text).slice(0, 80)}"`);
        }
        const historyRefs = l.refs.filter((ref) => ref.kind === "history");
        if (historyRefs.length > 0 && !historyRefs.some((ref) => historyRefMatchesText(db, personId, ref, l.text))) {
          conflicts.push(`claim text does not match its history reference: "${String(l.text).slice(0, 80)}"`);
        }
      }
    }
  }
  return { ok: conflicts.length === 0, conflicts: [...new Set(conflicts)] };
}

/** Snapshot of person + profile + facts at version time (append-only, never edited). */
export function snapshotForDocument(db, personId, profileId) {
  const person = getPerson(db, personId);
  const profile = getProfileFull(db, profileId);
  return {
    person: person ? { id: person.id, details: person.details } : null,
    profile: profile ? { id: profile.id, name: profile.name, version: profile.version, body: profile.body, snapshotId: pinSnapshot(db, profileId) } : null,
    facts: listFacts(db, personId).map((f) => ({ id: f.id, concept: f.concept, scope: f.scope, value: f.value, provenance: f.provenance })),
  };
}

// --- Versions (append-only) ------------------------------------------------

export function createDocument(db, { personId, profileId, kind, content, gaps = [] }) {
  if (!["resume", "cover_letter"].includes(kind)) throw new Error(`unknown document kind: ${kind}`);
  assertProfileBelongsToPerson(db, personId, profileId);
  const check = revalidateContent(db, personId, profileId, content);
  if (!check.ok) throw new Error(`document content failed revalidation: ${check.conflicts.join("; ")}`);
  const id = randomUUID();
  db.prepare("INSERT INTO documents (id, person_id, profile_id, kind) VALUES (?, ?, ?, ?)").run(id, personId, profileId, kind);
  const versionId = randomUUID();
  db.prepare(
    "INSERT INTO document_versions (id, document_id, version, content_json, gaps_json, status, conflicts_json, snapshot_json) VALUES (?, ?, 1, ?, ?, 'validated', '[]', ?)",
  ).run(versionId, id, JSON.stringify(content), JSON.stringify(gaps), JSON.stringify(snapshotForDocument(db, personId, profileId)));
  return { documentId: id, versionId, version: 1, status: "validated" };
}

/** Edit = a NEW append-only version with a fresh snapshot; old versions never change. */
export function editDocument(db, documentId, content) {
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(documentId);
  if (!doc) throw new Error("document not found");
  const check = revalidateContent(db, doc.person_id, doc.profile_id, content);
  const prev = db.prepare("SELECT MAX(version) AS m FROM document_versions WHERE document_id = ?").get(documentId).m ?? 0;
  const version = prev + 1;
  const versionId = randomUUID();
  db.prepare(
    "INSERT INTO document_versions (id, document_id, version, content_json, gaps_json, status, conflicts_json, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(versionId, documentId, version, JSON.stringify(content), JSON.stringify(content.gaps ?? []),
    check.ok ? "validated" : "needs_resolution", JSON.stringify(check.conflicts),
    JSON.stringify(snapshotForDocument(db, doc.person_id, doc.profile_id)));
  return { documentId, versionId, version, status: check.ok ? "validated" : "needs_resolution", conflicts: check.conflicts };
}

export function listDocumentVersions(db, documentId) {
  return db.prepare("SELECT * FROM document_versions WHERE document_id = ? ORDER BY version ASC").all(documentId).map((r) => ({
    ...r, content: JSON.parse(r.content_json), gaps: JSON.parse(r.gaps_json),
    conflicts: JSON.parse(r.conflicts_json), snapshot: JSON.parse(r.snapshot_json),
  }));
}

export function getDocumentVersion(db, documentId, version) {
  const row = db.prepare("SELECT * FROM document_versions WHERE document_id = ? AND version = ?").get(documentId, version);
  if (!row) return null;
  return {
    ...row, content: JSON.parse(row.content_json), gaps: JSON.parse(row.gaps_json),
    conflicts: JSON.parse(row.conflicts_json), snapshot: JSON.parse(row.snapshot_json),
  };
}

export function getLatestValidatedVersion(db, documentId) {
  const row = db.prepare("SELECT * FROM document_versions WHERE document_id = ? AND status = 'validated' ORDER BY version DESC LIMIT 1").get(documentId);
  if (!row) return null;
  return {
    ...row, content: JSON.parse(row.content_json), gaps: JSON.parse(row.gaps_json),
    conflicts: JSON.parse(row.conflicts_json), snapshot: JSON.parse(row.snapshot_json),
  };
}

export function listDocuments(db, personId, profileId = null) {
  const rows = profileId
    ? db.prepare("SELECT * FROM documents WHERE person_id = ? AND profile_id = ? ORDER BY created_at ASC").all(personId, profileId)
    : db.prepare("SELECT * FROM documents WHERE person_id = ? ORDER BY created_at ASC").all(personId);
  return rows.map((d) => ({ ...d, versions: listDocumentVersions(db, d.id).map((v) => ({ version: v.version, status: v.status })) }));
}

// --- Audit: zero contamination for documents -------------------------------

/** Every claim line in a document version must revalidate; returns the contamination count. */
export function auditDocumentVersion(db, personId, profileId, content) {
  const check = revalidateContent(db, personId, profileId, content);
  return { contamination: check.conflicts.length, conflicts: check.conflicts };
}

// --- PDF rendering (stdlib only, valid PDF with pagination) ---------------
// Text is encoded as WinAnsi (single-byte) and the file is assembled
// from Buffers throughout: every xref offset and stream Length is
// computed from the BYTES actually emitted, never from JS string
// lengths. (The old writer built a JS string, measured it as UTF-8,
// then emitted it as Latin-1: every non-ASCII character shifted all
// later offsets — e.g. each em dash by 2 bytes — and characters
// outside Latin-1 collapsed into control bytes.)

/** WinAnsi bytes for characters outside Latin-1 (0x80–0x9F range). */
const WINANSI_EXTRA = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87,
  "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

/**
 * Encode text for a PDF literal string in WinAnsi, escaping (, ) and
 * backslash. Accented Latin characters (á, é, ñ, ü, ç, …) and dashes
 * (–, —) map to their WinAnsi bytes; a character with no WinAnsi
 * mapping becomes "?" rather than a control byte.
 */
export function pdfEncodeText(s) {
  const bytes = [];
  for (const ch of String(s)) {
    if (ch === "(" || ch === ")" || ch === "\\") { bytes.push(0x5c, ch.codePointAt(0)); continue; }
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) { bytes.push(code); continue; }
    if (code >= 0xa0 && code <= 0xff) { bytes.push(code); continue; }
    if (WINANSI_EXTRA[ch] !== undefined) { bytes.push(WINANSI_EXTRA[ch]); continue; }
    bytes.push(0x3f); // "?" — never a control byte
  }
  return Buffer.from(bytes);
}

function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const w of words) {
    if (current.length + w.length + 1 > maxChars && current) { lines.push(current); current = w; }
    else current = current ? `${current} ${w}` : w;
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

/**
 * Render canonical content to a valid PDF Buffer (Helvetica with
 * WinAnsiEncoding, A4, margins, wrapped lines, "Page N of M" footer).
 * Short and long contents paginate the same way.
 */
export function renderPdf(content) {
  const fontSize = 11, headingSize = 14, leading = 15, margin = 54;
  const pageHeight = 842, usable = pageHeight - margin * 2 - 20;
  // First pass: lay out text lines into pages.
  const pages = [[]];
  let y = 0;
  const push = (text, size) => {
    const h = size === headingSize ? 20 : leading;
    if (y + h > usable) { pages.push([]); y = 0; }
    pages[pages.length - 1].push({ text, size, h });
    y += h;
  };
  push(content.title || "Document", headingSize);
  for (const section of content.sections || []) {
    if (section.heading) push(section.heading, headingSize);
    for (const l of section.lines || []) {
      for (const wrapped of wrapText(l.text || "", 95)) push(wrapped, fontSize);
    }
  }
  const totalPages = pages.length;
  const fontId = 3 + totalPages * 2;
  // Objects in id order: 1 catalog, 2 pages, then per page a page
  // object + content stream, then the two fonts.
  const objects = [];
  objects[1] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1");
  const pageObjIds = pages.map((_, i) => 3 + i * 2);
  const contentIds = pages.map((_, i) => 4 + i * 2);
  objects[2] = Buffer.from(`<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${totalPages} >>`, "latin1");
  pages.forEach((pageLines, i) => {
    const parts = [Buffer.from("BT /F1 11 Tf 54 788 Td 15 TL\n", "latin1")];
    let first = true;
    for (const item of pageLines) {
      if (!first) parts.push(Buffer.from("T*\n", "latin1"));
      first = false;
      parts.push(Buffer.from(`/${item.size === headingSize ? "F2" : "F1"} ${item.size} Tf (`, "latin1"));
      parts.push(pdfEncodeText(item.text));
      parts.push(Buffer.from(") Tj\n", "latin1"));
    }
    parts.push(Buffer.from(`ET\nBT /F1 9 Tf 54 40 Td (Page ${i + 1} of ${totalPages}) Tj ET`, "latin1"));
    const stream = Buffer.concat(parts);
    objects[pageObjIds[i]] = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R /F2 ${fontId + 1} 0 R >> >> /Contents ${contentIds[i]} 0 R >>`, "latin1");
    objects[contentIds[i]] = Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, "latin1"), stream, Buffer.from("\nendstream", "latin1"),
    ]);
  });
  objects[fontId] = Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>", "latin1");
  objects[fontId + 1] = Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>", "latin1");
  const chunks = [Buffer.from("%PDF-1.4\n", "latin1")];
  let length = chunks[0].length;
  const offsets = [0];
  const maxId = objects.length - 1;
  for (let i = 1; i <= maxId; i++) {
    offsets[i] = length;
    const head = Buffer.from(`${i} 0 obj\n`, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    chunks.push(head, objects[i], tail);
    length += head.length + objects[i].length + tail.length;
  }
  const xrefPos = length;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  chunks.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(chunks);
}

// --- DOCX rendering (stdlib only: ZIP with CRC32 + deflate) ---------------

const CRC_TABLE = (() => {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function zipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const crc = crc32(data);
    const compressed = deflateRawSync(data);
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + compressed.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDir, end]);
}

/** Render canonical content to a valid DOCX Buffer (same facts as the PDF). */
export function renderDocx(content) {
  const paras = [];
  const para = (text, bold) => `<w:p><w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
  paras.push(para(content.title || "Document", true));
  for (const section of content.sections || []) {
    if (section.heading) paras.push(para(section.heading, true));
    for (const l of section.lines || []) paras.push(para(l.text || "", false));
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join("")}</w:body></w:document>`;
  return zipBuffer([
    { name: "[Content_Types].xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`, "utf8") },
    { name: "word/document.xml", data: Buffer.from(documentXml, "utf8") },
  ]);
}

/** Render a document version's content in the requested format. */
export function renderVersionContent(content, format) {
  if (format === "pdf") return renderPdf(content);
  if (format === "docx") return renderDocx(content);
  throw new Error(`unsupported document format: ${format}`);
}

// --- Attachments (T-V2-047 / RF-V2-060) -----------------------------------

function safeFilename(kind, profileName, version, format) {
  const base = `${kind}-${String(profileName || "profile")}-v${version}`.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return `${base || "document"}.${format}`;
}

/**
 * Prepare an attachment for a portal role. Checks format against the
 * portal's allowed formats, size against its limit, and role against
 * the document kind. An impossible format fails with an explainable
 * error — never a silent wrong file. The row is "prepared" only;
 * portal_receipt stays null until a real observable portal signal
 * arrives (a hash alone never proves receipt).
 */
export function prepareAttachment(db, { documentId, version = null, format, role, portalRequirements = {} }) {
  if (!["pdf", "docx"].includes(format)) {
    throw new Error(`impossible attachment format: ${format} is not a format this system generates (pdf, docx)`);
  }
  const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(documentId);
  if (!doc) throw new Error("document not found");
  const versionRow = version === null
    ? getLatestValidatedVersion(db, documentId)
    : getDocumentVersion(db, documentId, version);
  if (!versionRow) throw new Error("no validated document version available for attachment");
  if (versionRow.status !== "validated") throw new Error(`document version ${versionRow.version} is ${versionRow.status}, not validated; it cannot be attached`);
  const allowed = /** @type {any} */ (portalRequirements).allowedFormats;
  if (Array.isArray(allowed) && !allowed.includes(format)) {
    throw new Error(`portal requires one of: ${allowed.join(", ")}; requested format ${format} cannot be prepared for this portal`);
  }
  if (role !== undefined && role !== null) {
    const expected = KIND_ROLE[doc.kind];
    if (role !== expected && role !== "other") {
      throw new Error(`attachment role ${role} does not match document kind ${doc.kind} (expected role: ${expected})`);
    }
  }
  const bytes = renderVersionContent(versionRow.content, format);
  const maxBytes = /** @type {any} */ (portalRequirements).maxBytes ?? MAX_ATTACHMENT_BYTES_DEFAULT;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) throw new Error("portal maxBytes must be a finite positive number");
  if (bytes.length > maxBytes) {
    throw new Error(`attachment of ${bytes.length} bytes exceeds the portal limit of ${maxBytes} bytes for format ${format}`);
  }
  const profile = getProfileFull(db, doc.profile_id);
  const filename = safeFilename(doc.kind, profile?.name, versionRow.version, format);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const id = randomUUID();
  db.prepare(
    "INSERT INTO document_attachments (id, document_version_id, format, mime, filename, bytes, sha256, role, status, portal_receipt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', NULL)",
  ).run(id, versionRow.id, format, FORMAT_MIME[format], filename, bytes, sha256, role ?? KIND_ROLE[doc.kind]);
  return {
    attachmentId: id, documentId, version: versionRow.version, format,
    mime: FORMAT_MIME[format], filename, bytesLength: bytes.length, sha256,
    role: role ?? KIND_ROLE[doc.kind], status: "prepared", portalReceipt: null,
    note: "prepared locally; a hash alone does not prove the portal received the file",
  };
}

export function getAttachment(db, attachmentId) {
  const row = db.prepare("SELECT * FROM document_attachments WHERE id = ?").get(attachmentId);
  if (!row) return null;
  const { bytes, ...rest } = row;
  return { ...rest, bytesLength: bytes.length };
}
