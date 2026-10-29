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
import { formatDateRange, parseQuestionText } from "./semantic.mjs";

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
 * interest/closing sentences, target-company line). ONLY a line that
 * is ENTIRELY template furniture may skip reference validation via
 * the template flag. Parameters carried by furniture (company names)
 * are controlled, not trusted: a parameter is a SINGLE entity, so it
 * must never contain claim wording (degree/language/employment
 * claims, "I hold/I have/I speak" content) or a second sentence
 * carrying such a claim. School/college/university words inside a
 * company NAME are legitimate ("Greenfield School" is a company, not
 * a personal claim) and are therefore NOT claim wording here — the
 * previous guard rejected them and broke destination companies.
 */
/** Claim wording that must never hide inside a template parameter. */
const PARAM_CLAIM_WORDS = /(\bi\s+(hold|have|has|had|speak|spoke|am|was|were|worked|managed|led|earned|completed|graduated|studied)\b|\bmy\s+(degree|education|experience)\b|\b(phd|doctorate|degree|bachelor|fluent|fluently|hablo)\b|\b\d+\s+years?\s+of\s+experience\b)/i;

function companyParamHasClaim(rest) {
  const t = String(rest ?? "").trim();
  if (PARAM_CLAIM_WORDS.test(t)) return true;
  // A second sentence carrying a personal-claim verb is smuggling,
  // even without a degree keyword ("Acme. I worked there for years").
  const sentences = t.split(/[.?!]\s+/);
  return sentences.length > 1 && sentences.slice(1).some((s) =>
    /\b(i|we|he|she|they|you)\s+(hold|have|has|had|speak|spoke|am|was|were|worked|managed|led|earned|completed|graduated|studied)\b/i.test(s));
}

function templateTailHasClaim(tail) {
  return /(i (have|speak|worked|am|hold)|my (experience|education|degree|skills)|degree|phd|doctorate|university|college|institute|school|fluent|hablo|speak)/i.test(tail)
    || /\s[–—-]\s/.test(tail);
}

function isSystemTemplate(text) {
  const t = String(text ?? "").trim();
  const greeting = t.match(/^Dear (.* )?Hiring Team,$/);
  if (greeting) return !greeting[1] || !companyParamHasClaim(greeting[1].trim());
  const interest = t.match(/^I am writing to express my interest in (?:the (.+?) position(?: at (.+))?|a position matching my profile)\.$/);
  if (interest) return !interest[2] || !companyParamHasClaim(interest[2].trim());
  if (/^I would welcome the opportunity to discuss how my background fits this position\.$/.test(t)) return true;
  if (t.startsWith("Sincerely,")) {
    const rest = t.slice("Sincerely,".length).trim();
    return rest !== "" && !templateTailHasClaim(rest);
  }
  if (t.startsWith("Target company:")) {
    const rest = t.slice("Target company:".length).trim();
    return rest !== "" && !companyParamHasClaim(rest);
  }
  return false;
}

const EDUCATION_LEVEL_KEYS = ["phd", "doctorate", "doctoral", "master", "masters", "mba", "msc", "bachelor", "bachelors", "bsc", "ba", "degree", "diploma"];

/** Education levels grouped so aliases of one level match each other
 * (PhD = doctorate = doctoral; MSc/MBA = master) but never upgrade
 * one level into another: a BSc entry can never support a PhD claim,
 * however many institution tokens they share. "degree"/"diploma" are
 * generic: they claim no specific level, so token overlap decides. */
const LEVEL_GROUPS = {
  doctorate: new Set(["phd", "doctorate", "doctoral"]),
  master: new Set(["master", "masters", "msc", "mba"]),
  bachelor: new Set(["bachelor", "bachelors", "bsc", "ba"]),
  generic: new Set(["degree", "diploma"]),
};

function levelGroups(text) {
  const groups = new Set();
  for (const level of claimLevels(text)) {
    for (const [group, members] of Object.entries(LEVEL_GROUPS)) {
      if (members.has(level)) groups.add(group);
    }
  }
  return groups;
}

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


/**
 * Does one reference actually SUPPORT an education claim — fully, not
 * partially? A history education entry supports it only when ALL
 * asserted fields match that SAME entry: level group, subject,
 * institution and dates (see educationRefSupports). A skills ref, an
 * employment ref, or any unrelated fact never supports an education
 * claim, however the client flags the line.
 */
function escapeRegExp(s) {
  return String(s ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A year range asserted in free text, if any ("2020 – 2024", "January 2020 – June 2024", "2020 – Present"). */
function claimYearRange(text) {
  const m = String(text ?? "").match(/(\d{4})\s*[–—-]\s*(?:[A-Za-z]+\s+)?(\d{4}|Present|Unknown)/);
  return m ? { startYear: m[1], end: m[2] } : null;
}

/** Years mentioned in free text outside a range. */
function claimYears(text) {
  return [...new Set((String(text ?? "").match(/\b\d{4}\b/g) || []))];
}

/**
 * Do the dates asserted in a line match ONE held entry? A range must
 * match start and end exactly (end is a year, "Present" only with
 * current:true, "Unknown" otherwise); a lone year must be the entry's
 * start or end year. No range and no years asserted: nothing to check.
 */
function entryDatesMatch(text, entry) {
  const range = claimYearRange(text);
  const startYear = entry?.start ? String(entry.start).match(/\d{4}/)?.[0] ?? null : null;
  const endYear = entry?.end ? String(entry.end).match(/\d{4}/)?.[0] ?? null : null;
  if (range) {
    if (!startYear || startYear !== range.startYear) return false;
    const expectedEnd = endYear ?? (entry?.current === true ? "Present" : "Unknown");
    return range.end === expectedEnd;
  }
  const years = claimYears(text);
  if (years.length === 0) return true;
  if (!startYear && !endYear) return false;
  return years.every((y) => y === startYear || y === endYear);
}

/** The held history entry behind a ref: the stored entry first (it carries `current`), else the ref's snapshot. */
function resolveHistoryEntry(db, personId, ref, entryKind) {
  const person = getPerson(db, personId);
  const list = entryKind === "education" ? (person?.details?.education ?? []) : (person?.details?.employment ?? []);
  return list.find((e) => e.id === ref.id) ?? ref.value ?? null;
}

/** Subject tokens of an education claim: claim words minus level words, stopwords, furniture, institution words and dates. */
function educationSubjectTokens(claimText, institutionWords) {
  const stop = new Set(["university", "college", "institute", "school", "of", "the", "and", "de", "la", "at", "in", "from", "my", "education", "includes", "include", "a", "an", "is", "with"]);
  const months = new Set(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]);
  return new Set(claimWords(claimText).filter((w) =>
    !EDUCATION_LEVEL_KEYS.includes(w) && !stop.has(w) && !institutionWords.has(w) && !months.has(w)
    && !/^\d{4}$/.test(w) && w !== "present" && w !== "unknown"));
}

function educationRefSupports(db, personId, ref, claimText) {
  const specificClaim = new Set([...levelGroups(claimText)].filter((g) => g !== "generic"));
  const claimWordSet = new Set(claimWords(claimText));
  // ALL asserted fields must match this ONE source: level group,
  // every subject token in the support title, every significant
  // institution token in the claim, and asserted dates in the entry.
  // A claim naming no subject ("PhD") is supported by any same-level
  // entry; a generic claim ("degree in …") claims no specific level,
  // so subject overlap decides.
  const checkSupport = (supportText, supportTitleWords, supportInstitutionWords, supportEntry) => {
    if (specificClaim.size > 0) {
      const supportGroups = levelGroups(supportText);
      if (![...specificClaim].some((g) => supportGroups.has(g))) return false;
    }
    const subjects = educationSubjectTokens(claimText, supportInstitutionWords);
    if (![...subjects].every((tok) => supportTitleWords.has(tok))) return false;
    const instSignificant = new Set([...supportInstitutionWords].filter((w) => w.length >= 4));
    if (![...instSignificant].every((tok) => claimWordSet.has(tok))) return false;
    if (supportEntry) return entryDatesMatch(claimText, supportEntry);
    const range = claimYearRange(claimText);
    if (range && !(supportText.includes(range.startYear) && (/\d{4}/.test(range.end) ? supportText.includes(range.end) : true))) return false;
    return true;
  };
  if (ref.kind === "history" && ref.entryKind === "education") {
    const entry = resolveHistoryEntry(db, personId, ref, "education");
    if (!entry) return false;
    const supportText = `${entry.title ?? ""} ${entry.institution ?? ""}`;
    return checkSupport(supportText, new Set(claimWords(entry.title ?? "")), new Set(claimWords(entry.institution ?? "")), entry);
  }
  if (ref.kind === "fact") {
    const row = db.prepare("SELECT * FROM declared_facts WHERE id = ? AND person_id = ? AND confirmation_state = 'confirmed'").get(ref.id, personId);
    if (!row || row.concept !== "highest_education") return false;
    let value;
    try { value = JSON.parse(row.value_json); } catch { return false; }
    const valueText = typeof value === "string" ? value : JSON.stringify(value);
    return checkSupport(valueText, new Set(claimWords(valueText)), new Set(), null);
  }
  return false;
}

/**
 * Does one employment history reference FULLY support an employment
 * line? ALL asserted fields must match that SAME entry. A shaped
 * resume line ("Title — Employer (dates)") must match title,
 * employer and dates field by field, so an unchanged employer can no
 * longer carry an invented title and invented dates. An unshaped line
 * (a cover-letter argument) must contain no significant token outside
 * furniture, dates and the entry's own title/employer words, and its
 * dates must match the entry.
 */
function employmentRefSupports(db, personId, ref, claimText) {
  const entry = resolveHistoryEntry(db, personId, ref, "employment");
  if (!entry) return false;
  const text = String(claimText ?? "");
  const shaped = text.match(/^(.+?)\s+[–—-]\s+(.+?)\s*\(([^)]*)\)\s*$/);
  if (shaped) {
    const titleOk = !isNonEmptyString(entry.title) || shaped[1].trim().toLowerCase() === String(entry.title).toLowerCase();
    const employerOk = !isNonEmptyString(entry.employer) || shaped[2].trim().toLowerCase() === String(entry.employer).toLowerCase();
    return titleOk && employerOk && entryDatesMatch(text, entry);
  }
  const furniture = new Set(["my", "experience", "as", "at", "is", "directly", "relevant", "to", "this", "role", "worked", "for", "with", "in", "of", "the", "a", "an", "and", "from", "on", "i", "we", "he", "she", "they", "you", "me", "him", "her", "us", "them", "have", "has", "had", "was", "were", "been", "be", "am", "are", "since", "until", "during", "between", "currently", "previously", "formerly"]);
  const months = new Set(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]);
  const entryWords = new Set([...claimWords(entry.title ?? ""), ...claimWords(entry.employer ?? "")]);
  const tokens = claimWords(text).filter((w) =>
    !furniture.has(w) && !months.has(w) && !/^\d{4}$/.test(w) && w !== "present" && w !== "unknown");
  if (!tokens.every((tok) => entryWords.has(tok))) return false;
  return entryDatesMatch(text, entry);
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

// --- Content matching per claim type (generalised claim-to-support) ---
// A reference must support the claim's CONTENT, not merely exist or
// share a broad category: a language claim needs a language source
// naming that language (a skill fact about another skill never
// supports it), a listed skill must be held, an authorisation claim
// needs a matching authorisation fact, and an employment claim needs
// a history employment entry. Same-category-but-different-content is
// a conflict.

const LANGUAGE_NAMES = [
  "mandarin", "chinese", "cantonese", "english", "spanish", "french", "german",
  "italian", "portuguese", "dutch", "polish", "russian", "arabic", "japanese",
  "korean", "hindi", "bengali", "turkish", "swedish", "norwegian", "danish",
  "finnish", "greek", "czech", "slovak", "hungarian", "romanian", "ukrainian",
  "thai", "vietnamese", "indonesian", "malay", "hebrew", "persian", "farsi",
  "urdu", "punjabi", "tamil", "telugu", "marathi", "gujarati", "basque",
  "catalan", "galician", "welsh", "irish", "latin",
];
const LANGUAGE_VERBS = [
  "speak", "speaks", "speaking", "fluent", "fluency", "proficiency",
  "hablo", "habla", "hablas", "idioma", "language",
  "native", "beginner", "intermediate", "advanced",
];

/** Languages a line actually claims (verb/level context, or a bare "X: Level" line). */
function languagesClaimed(text) {
  const words = new Set(claimWords(text));
  const lower = String(text ?? "").toLowerCase();
  const hasVerb = LANGUAGE_VERBS.some((v) => words.has(v));
  const found = [];
  for (const lang of LANGUAGE_NAMES) {
    if (!words.has(lang)) continue;
    if (hasVerb) found.push(lang);
    else if (new RegExp(`^\\s*${lang}\\s*:`).test(lower) || /^\s*language\s*:/.test(lower)) found.push(lang);
  }
  return found;
}

function languageNameMatches(entryLang, claimed) {
  const e = String(entryLang ?? "").toLowerCase().trim();
  return e === claimed || (e.includes(claimed) && claimed.length >= 4) || (claimed.includes(e) && e.length >= 4);
}

const LEVEL_WORDS = ["native", "fluent", "beginner", "intermediate", "advanced", "elementary", "proficient", "a1", "a2", "b1", "b2", "c1", "c2"];

function normalizeLevel(w) {
  const l = String(w ?? "").toLowerCase();
  return l === "fluently" ? "fluent" : l;
}

/**
 * The level a line asserts for a language, if any: "Mandarin: native"
 * (colon form) or a level word near the language name ("I speak
 * Mandarin fluently"). Null when the line asserts no level — then the
 * language name alone is what must be backed.
 */
function languageLevelClaimed(text, lang) {
  const lower = String(text ?? "").toLowerCase();
  const colon = lower.match(new RegExp(`\\b${escapeRegExp(lang)}\\s*:\\s*([a-z][a-z0-9]*)`));
  if (colon) {
    const n = normalizeLevel(colon[1]);
    if (LEVEL_WORDS.includes(n)) return n;
  }
  const prox = lower.match(new RegExp(`\\b${escapeRegExp(lang)}\\b.{0,40}?\\b(native|fluent|fluently|beginner|intermediate|advanced|elementary|proficient|a1|a2|b1|b2|c1|c2)\\b`))
    || lower.match(new RegExp(`\\b(native|fluent|fluently|beginner|intermediate|advanced|elementary|proficient|a1|a2|b1|b2|c1|c2)\\b.{0,40}?\\b${escapeRegExp(lang)}\\b`));
  return prox ? normalizeLevel(prox[1]) : null;
}

function languageRefSupports(db, personId, ref, lang, claimedLevel = null) {
  const levelOk = (heldLevel) => claimedLevel === null || normalizeLevel(heldLevel) === claimedLevel;
  if (ref.kind === "person" && ref.field === "languages") {
    const value = ref.value ?? getPerson(db, personId)?.details?.languages;
    return Array.isArray(value) && value.some((l) => languageNameMatches(l.language, lang) && levelOk(l.level));
  }
  if (ref.kind === "fact") {
    const row = db.prepare("SELECT * FROM declared_facts WHERE id = ? AND person_id = ? AND confirmation_state = 'confirmed'").get(ref.id, personId);
    if (!row) return false;
    let value;
    try { value = JSON.parse(row.value_json); } catch { return false; }
    const valueText = typeof value === "string" ? value : JSON.stringify(value);
    if (!new RegExp(`\\b${lang}\\b`, "i").test(valueText)) return false;
    if (!( /language/i.test(row.concept) || /language|level|proficiency/i.test(row.concept))) return false;
    if (claimedLevel === null) return true;
    const normalized = valueText.toLowerCase().replace(/\bfluently\b/g, "fluent");
    return new RegExp(`\\b${escapeRegExp(claimedLevel)}\\b`).test(normalized);
  }
  return false;
}

/** Skills a "My skills include A, B and C" line actually lists (null when it lists none). */
function skillListClaimed(text) {
  const m = String(text ?? "").match(/skills?\s+include\s+(.+)/i);
  if (!m) return null;
  return m[1].replace(/[.。]\s*$/, "").split(/\s*,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean);
}

function skillMatches(item, skill) {
  const a = claimWords(item);
  const b = claimWords(skill);
  if (a.length === 0 || b.length === 0) return false;
  return a.every((w) => b.includes(w)) || b.every((w) => a.includes(w));
}

function heldSkills(db, personId, profileId, skillsRefs) {
  for (const ref of skillsRefs) {
    if (Array.isArray(ref.value)) return ref.value;
  }
  const profile = getProfileFull(db, profileId);
  return Array.isArray(profile?.body?.skills) ? profile.body.skills : [];
}

/** Polarity of a stored fact value: "yes" for yes/true/authorised/required, "no" for no/false, else null. */
function factPolarity(value) {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (["yes", "true", "authorised", "authorized", "required"].includes(v)) return "yes";
    if (["no", "false", "not required", "not_required"].includes(v)) return "no";
    return null;
  }
  if (value && typeof value === "object") {
    if (value.value !== undefined) return factPolarity(value.value);
    if (value.answer !== undefined) return factPolarity(value.answer);
  }
  return null;
}

/**
 * Does one fact support an authorisation/sponsorship claim — scope
 * AND polarity? A positive claim needs a positive ("yes") backing
 * fact; a "no" fact can never support a "yes" claim, and vice versa.
 */
function authorisationRefSupports(db, personId, ref, parsedClaim) {
  if (ref.kind !== "fact") return false;
  const row = db.prepare("SELECT * FROM declared_facts WHERE id = ? AND person_id = ? AND confirmation_state = 'confirmed'").get(ref.id, personId);
  if (!row || row.concept !== parsedClaim.concept) return false;
  if (parsedClaim.scope && row.scope !== parsedClaim.scope) return false;
  let value;
  try { value = JSON.parse(row.value_json); } catch { return false; }
  const polarity = factPolarity(value);
  if (polarity === null) return false;
  return polarity === (parsedClaim.negated ? "no" : "yes");
}

/** Quantified assertions in a line: money, scaled numbers, percentages, headcounts, experience durations. */
function quantitiesClaimed(text) {
  const s = String(text ?? "");
  const out = [];
  const used = [];
  const push = (start, end, q) => {
    if (used.some(([a, b]) => start < b && end > a)) return;
    used.push([start, end]);
    out.push(q);
  };
  const num = (raw) => Number(String(raw).replace(/,/g, ""));
  for (const m of s.matchAll(/(EUR|USD|GBP|CHF|€|\$|£)\s*([\d,]+(?:\.\d+)?)\s*(million|billion|thousand)?/gi)) {
    push(m.index, m.index + m[0].length, { raw: m[0], kind: "money", number: num(m[2]), scale: m[3]?.toLowerCase() ?? null, currency: m[1] });
  }
  for (const m of s.matchAll(/([\d,]+(?:\.\d+)?)\s*(million|billion|thousand)\b/gi)) {
    push(m.index, m.index + m[0].length, { raw: m[0], kind: "scaled", number: num(m[1]), scale: m[2].toLowerCase(), currency: null });
  }
  for (const m of s.matchAll(/([\d,]+(?:\.\d+)?)\s*%/g)) {
    push(m.index, m.index + m[0].length, { raw: m[0], kind: "percent", number: num(m[1]), scale: null, currency: null });
  }
  for (const m of s.matchAll(/\bteam of\s+([\d,]+)/gi)) {
    push(m.index, m.index + m[0].length, { raw: m[0], kind: "headcount", number: num(m[1]), scale: null, currency: null });
  }
  for (const m of s.matchAll(/([\d,]+)\s+(people|employees|direct reports|team members)\b/gi)) {
    push(m.index, m.index + m[0].length, { raw: m[0], kind: "headcount", number: num(m[1]), scale: null, currency: null });
  }
  for (const m of s.matchAll(/([\d,]+)\s+years?\s+of\s+experience/gi)) {
    push(m.index, m.index + m[0].length, { raw: m[0], kind: "experience_years", number: num(m[1]), scale: null, currency: null });
  }
  return out;
}

const SCALE_MULTIPLIER = { thousand: 1e3, million: 1e6, billion: 1e9 };
const CURRENCY_ALIASES = { eur: ["eur", "€"], usd: ["usd", "$"], gbp: ["gbp", "£"], chf: ["chf"] };

/** Backing text behind one reference (fact value, history entry, or profile/person field value). */
function refSourceText(db, personId, profileId, ref) {
  if (ref.kind === "fact") {
    const row = db.prepare("SELECT value_json FROM declared_facts WHERE id = ? AND person_id = ?").get(ref.id, personId);
    if (!row) return "";
    try { const v = JSON.parse(row.value_json); return typeof v === "string" ? v : JSON.stringify(v); } catch { return row.value_json; }
  }
  if (ref.kind === "history") {
    const entry = resolveHistoryEntry(db, personId, ref, ref.entryKind);
    return entry ? JSON.stringify(entry) : "";
  }
  if (ref.kind === "profile") {
    if (ref.value !== undefined) return JSON.stringify(ref.value);
    const profile = getProfileFull(db, profileId);
    return JSON.stringify(profile?.body?.[ref.field] ?? "");
  }
  if (ref.kind === "person") {
    if (ref.value !== undefined) return JSON.stringify(ref.value);
    const person = getPerson(db, personId);
    return JSON.stringify(person?.details?.[ref.field] ?? "");
  }
  return "";
}

/** Total held employment span in whole years (union of entry intervals; unknown ends excluded). */
function heldEmploymentYears(db, personId) {
  const person = getPerson(db, personId);
  const intervals = [];
  for (const e of person?.details?.employment ?? []) {
    const sy = e?.start ? Number(String(e.start).match(/\d{4}/)?.[0] ?? NaN) : NaN;
    if (!Number.isFinite(sy)) continue;
    let ey = e?.end ? Number(String(e.end).match(/\d{4}/)?.[0] ?? NaN) : NaN;
    if (!Number.isFinite(ey)) ey = e?.current === true ? new Date().getFullYear() : NaN;
    if (Number.isFinite(ey) && ey >= sy) intervals.push([sy, ey]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur = null;
  for (const [sy, ey] of intervals) {
    if (!cur || sy > cur[1]) { if (cur) total += cur[1] - cur[0]; cur = [sy, ey]; }
    else cur[1] = Math.max(cur[1], ey);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/** Does ONE reference back a quantified assertion (same source: value AND unit must both be there)? */
function quantityBackedByRef(db, personId, profileId, ref, q, lineHasEmploymentRef) {
  if (q.kind === "experience_years") {
    if (lineHasEmploymentRef && heldEmploymentYears(db, personId) >= q.number) return true;
    return refSourceText(db, personId, profileId, ref).toLowerCase().includes(String(q.number));
  }
  const src = refSourceText(db, personId, profileId, ref).toLowerCase();
  const nums = [...src.matchAll(/[\d,]+(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, "")));
  const expanded = q.scale ? q.number * SCALE_MULTIPLIER[q.scale] : null;
  if (expanded !== null && nums.includes(expanded)) return true;
  if (!nums.includes(q.number)) return false;
  if (q.kind === "percent") return src.includes("%");
  if (q.kind === "headcount") return /(people|employees|direct reports|team members)/.test(src);
  if (q.scale) return src.includes(q.scale);
  if (q.currency) {
    const aliases = CURRENCY_ALIASES[q.currency.toLowerCase()] ?? [q.currency.toLowerCase()];
    return aliases.some((a) => src.includes(a));
  }
  return false;
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
 * Does a section heading itself STATE a claim? Headings carry no
 * references, so any claim-like heading can never validate — but
 * plain labels ("Experience", "Education", "Skills") and name headers
 * are not claims and stay valid. Covers education, history entries,
 * language claims ("I speak Mandarin fluently."), authorisation /
 * sponsorship claims, quantified assertions and skill lists.
 */
function headingStatesClaim(heading, person) {
  if (isEducationClaim(heading)) return true;
  const historyEntries = [
    ...(person?.details?.employment ?? []).map((e) => ({ title: e.title, org: e.employer })),
    ...(person?.details?.education ?? []).map((e) => ({ title: e.title, org: e.institution })),
  ];
  if (historyEntries.some((e) => isNonEmptyString(e.title) && isNonEmptyString(e.org)
    && heading.toLowerCase().includes(String(e.title).toLowerCase())
    && heading.toLowerCase().includes(String(e.org).toLowerCase()))) return true;
  if (languagesClaimed(heading).length > 0) return true;
  const parsed = parseQuestionText(heading);
  if (parsed.concept === "work_authorisation" || parsed.concept === "sponsorship_required") return true;
  if (quantitiesClaimed(heading).length > 0) return true;
  if (/\b(experience as|worked\s+(as|at|for)|employed\s+(as|at|by))\b/i.test(heading)) return true;
  if (skillListClaimed(heading)) return true;
  return false;
}

/** First-person experience/achievement verbs: a sentence using them asserts more than a held skill name. */
const ACTION_VERBS = /\b(I|my)\b[^.]*\b(managed|led|increased|reduced|delivered|built|created|improved|achieved|earned|won|founded|started|ran|supervised|coordinated|developed|designed|implemented|drove|grew|negotiated|launched)\b/i;

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
        if (headingStatesClaim(heading, person)) {
          conflicts.push(`section heading states a claim but carries no references: "${String(heading).slice(0, 80)}"`);
        }
      }
      if (!Array.isArray(section.lines)) { conflicts.push("section lines must be an array"); continue; }
      for (const l of section.lines) {
        // Template exemption applies ONLY to a line that is ENTIRELY
        // genuine system furniture. Any other template-flagged line
        // is validated as a claim.
        if (l.template && isSystemTemplate(l.text)) continue;
        if (!Array.isArray(l.refs) || l.refs.length === 0) {
          conflicts.push(`unreferenced claim: "${String(l.text ?? "").slice(0, 80)}"`);
          continue;
        }
        for (const ref of l.refs) {
          const problem = checkRef(db, personId, profileId, ref);
          if (problem) conflicts.push(problem);
        }
        const historyRefs = l.refs.filter((ref) => ref.kind === "history");
        // Claim-to-support: a reference must actually support the
        // claim's CONTENT, not merely exist.
        // Education: exact level group + subject overlap — except a
        // line backed by a MATCHING employment entry is employment,
        // never reclassified as an education claim because its
        // employer happens to be a school/college.
        if (isEducationClaim(l.text)) {
          const employmentBacked = historyRefs.some((ref) => ref.entryKind === "employment" && historyRefMatchesText(db, personId, ref, l.text));
          const levelClaimed = claimLevels(l.text).size > 0;
          if (levelClaimed || !employmentBacked) {
            const supported = l.refs.some((ref) => educationRefSupports(db, personId, ref, l.text));
            if (!supported) conflicts.push(`education claim not supported by its references: "${String(l.text).slice(0, 80)}"`);
          }
        }
        // Language: every claimed language needs a language source
        // naming it AND asserting the same level when one is claimed
        // ("Mandarin: native" is not backed by a Mandarin A1 entry);
        // a skill fact about another skill never supports it.
        for (const lang of languagesClaimed(l.text)) {
          const supported = l.refs.some((ref) => languageRefSupports(db, personId, ref, lang, languageLevelClaimed(l.text, lang)));
          if (!supported) conflicts.push(`language claim not supported by its references: "${String(l.text).slice(0, 80)}"`);
        }
        // Skills: a listed skill must be held; a single-phrase line
        // backed by the skills field must name a held skill.
        const skillsRefs = l.refs.filter((ref) => ref.kind === "profile" && ref.field === "skills");
        if (skillsRefs.length > 0) {
          const held = heldSkills(db, personId, profileId, skillsRefs);
          const listed = skillListClaimed(l.text);
          if (listed) {
            for (const item of listed) {
              if (!held.some((s) => skillMatches(item, s))) conflicts.push(`skill "${item}" is not held on the profile: "${String(l.text).slice(0, 80)}"`);
            }
          } else {
            const stripped = String(l.text ?? "").trim().replace(/[.。]\s*$/, "");
            const items = stripped.includes(",")
              ? stripped.split(/\s*,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean)
              : [stripped];
            for (const item of items) {
              const words = claimWords(item);
              if (words.length > 0 && words.length <= 5 && !/^(my|i|we|the|a|an)\b/i.test(item) && !/[.!?]\s+\S/.test(item)) {
                if (!held.some((s) => skillMatches(item, s))) conflicts.push(`skill "${item}" is not held on the profile: "${String(l.text).slice(0, 80)}"`);
              }
            }
          }
        }
        // Authorisation/sponsorship: needs a fact for the claimed
        // concept AND scope AND polarity — a "no" fact can never
        // support a "yes" claim, and vice versa.
        const parsedClaim = parseQuestionText(l.text);
        if (parsedClaim.concept === "work_authorisation" || parsedClaim.concept === "sponsorship_required") {
          const supported = l.refs.some((ref) => authorisationRefSupports(db, personId, ref, parsedClaim));
          if (!supported) conflicts.push(`authorisation claim not supported by its references: "${String(l.text).slice(0, 80)}"`);
        }
        // Employment: a line claiming employment experience without
        // any history employment reference is not backed.
        if (!historyRefs.some((ref) => ref.entryKind === "employment")
          && /\b(experience as|worked\s+(as|at|for)|employed\s+(as|at|by))\b/i.test(l.text)) {
          conflicts.push(`employment claim not supported by a history reference: "${String(l.text).slice(0, 80)}"`);
        }
        if (historyRefs.length > 0 && !historyRefs.some((ref) => historyRefMatchesText(db, personId, ref, l.text))) {
          conflicts.push(`claim text does not match its history reference: "${String(l.text).slice(0, 80)}"`);
        }
        // Employment: ALL asserted fields (title, employer, dates)
        // must match ONE entry — an unchanged employer can no longer
        // carry an invented title or invented dates.
        for (const ref of historyRefs.filter((r) => r.entryKind === "employment")) {
          if (!employmentRefSupports(db, personId, ref, l.text)) {
            conflicts.push(`employment claim not fully supported by its history reference: "${String(l.text).slice(0, 80)}"`);
          }
        }
        // Quantified assertions: money, scaled numbers, percentages,
        // headcounts and experience durations must be backed by ONE
        // reference carrying that value and unit — a valid ref plus
        // an unbacked quantity is a conflict.
        const lineHasEmploymentRef = historyRefs.some((r) => r.entryKind === "employment");
        for (const q of quantitiesClaimed(l.text)) {
          const backed = l.refs.some((ref) => quantityBackedByRef(db, personId, profileId, ref, q, lineHasEmploymentRef));
          if (!backed) conflicts.push(`quantified assertion not supported by its references: "${q.raw}" in "${String(l.text).slice(0, 80)}"`);
        }
        // Action sentences backed only by skill refs assert experience
        // or achievement, not a held skill name — they need an
        // employment or fact reference backing the action itself.
        if (skillsRefs.length > 0 && !skillListClaimed(l.text) && ACTION_VERBS.test(l.text)
          && !historyRefs.some((r) => r.entryKind === "employment") && !l.refs.some((r) => r.kind === "fact")) {
          conflicts.push(`experience/achievement claim not supported by an employment or fact reference: "${String(l.text).slice(0, 80)}"`);
        }
        // Bare contact values backed by a person field must BE that
        // value — editing the text while keeping the ref is not backing.
        for (const ref of l.refs.filter((r) => r.kind === "person" && (r.field === "email" || r.field === "phone"))) {
          const t = String(l.text ?? "").trim();
          if (typeof ref.value === "string" && !/\s/.test(t) && t !== ref.value) {
            conflicts.push(`line text does not match its person reference: "${String(l.text).slice(0, 80)}"`);
          }
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
// outside Latin-1 collapsed into control bytes.) Central European
// glyphs outside WinAnsi ride a /Differences encoding (see
// POLISH_MAP); anything still unrepresentable fails fast via
// assertPdfRepresentable instead of mangling a name into "?".

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
 * (–, —) map to their WinAnsi bytes. Central European characters
 * outside WinAnsi (Ł, ż, Ć, …) map to rarely-used WinAnsi codes whose
 * glyphs are renamed through the font's /Differences array (see
 * pdfFontObject), so pdf.js and strict readers extract them exactly.
 * A character with no mapping at all becomes "?" rather than a
 * control byte — but renderPdf refuses to emit such a document at
 * all (see assertPdfRepresentable): a PDF must never silently mangle
 * an official name.
 */
export function pdfEncodeText(s) {
  const bytes = [];
  for (const ch of String(s)) {
    if (ch === "(" || ch === ")" || ch === "\\") { bytes.push(0x5c, ch.codePointAt(0)); continue; }
    const code = ch.codePointAt(0);
    if (code >= 0x20 && code <= 0x7e) { bytes.push(code); continue; }
    if (code >= 0xa0 && code <= 0xff) { bytes.push(code); continue; }
    if (WINANSI_EXTRA[ch] !== undefined) { bytes.push(WINANSI_EXTRA[ch]); continue; }
    if (POLISH_MAP[ch] !== undefined) { bytes.push(POLISH_MAP[ch][0]); continue; }
    bytes.push(0x3f); // "?" — never a control byte
  }
  return Buffer.from(bytes);
}

/**
 * Central European glyphs outside WinAnsi, mapped to rarely-used
 * WinAnsi codes (superscripts, fractions, inverted marks — characters
 * that do not occur in resumes and cover letters) with their standard
 * AFM glyph names. The font's /Differences array renames those codes
 * to the glyphs, so extraction returns the real characters. A
 * document containing BOTH a Polish character and the Latin-1
 * character that owns its code is a collision and is unrepresentable
 * (see assertPdfRepresentable).
 */
const POLISH_MAP = {
  "Ł": [0xb3, "Lslash"], "ł": [0xb2, "lslash"],
  "Ż": [0xb9, "Zdotaccent"], "ż": [0xbc, "zdotaccent"],
  "Ć": [0xbd, "Cacute"], "ć": [0xbe, "cacute"],
  "Ń": [0xa6, "Nacute"], "ń": [0xa8, "nacute"],
  "Ś": [0xaf, "Sacute"], "ś": [0xb4, "sacute"],
  "Ą": [0xb8, "Aogonek"], "ą": [0xa1, "aogonek"],
  "Ę": [0xbf, "Eogonek"], "ę": [0xa7, "eogonek"],
};

/** Characters in text that no PDF mapping in this writer can represent. */
export function pdfUnrepresentableChars(text) {
  const bad = [];
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    if (ch === "(" || ch === ")" || ch === "\\") continue;
    // Whitespace separators never reach a PDF literal string (layout
    // splits on whitespace first); any other control byte is refused.
    if (ch === "\n" || ch === "\r" || ch === "\t") continue;
    if (code >= 0x20 && code <= 0x7e) continue;
    if (code >= 0xa0 && code <= 0xff) continue;
    if (WINANSI_EXTRA[ch] !== undefined) continue;
    if (POLISH_MAP[ch] !== undefined) continue;
    if (!bad.includes(ch)) bad.push(ch);
  }
  return bad;
}

/**
 * Render-fidelity guard: a document whose canonical text contains a
 * character the PDF writer cannot represent exactly (or a Polish /
 * Latin-1 code collision) must never validate as a PDF or be
 * prepared as a PDF attachment. Throws naming the characters and
 * pointing at DOCX, which is UTF-8 and renders them exactly. The
 * document itself stays valid — only its PDF rendering is refused.
 */
export function assertPdfRepresentable(content) {
  const texts = [content.title || ""];
  for (const section of content.sections || []) {
    if (section.heading) texts.push(section.heading);
    for (const l of section.lines || []) texts.push(l.text || "");
  }
  const all = texts.join("\n");
  const bad = pdfUnrepresentableChars(all);
  for (const [ch, [code]] of Object.entries(POLISH_MAP)) {
    if (all.includes(ch) && all.includes(String.fromCodePoint(Number(code))) && !bad.includes(ch)) bad.push(ch);
  }
  if (bad.length > 0) {
    const names = bad.map((ch) => `${ch} (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")})`).join(", ");
    throw new Error(`PDF cannot represent character(s): ${names}. The PDF attachment cannot be prepared with mangled text; the same content renders exactly in DOCX.`);
  }
}

/** Font object for a base font, with /Differences for the Polish glyphs actually used. */
function pdfFontObject(baseFont, usedPolish) {
  if (usedPolish.size === 0) {
    return Buffer.from(`<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} /Encoding /WinAnsiEncoding >>`, "latin1");
  }
  const entries = [...usedPolish].map((ch) => POLISH_MAP[ch]).sort((a, b) => a[0] - b[0]);
  let diff = "";
  let i = 0;
  while (i < entries.length) {
    let j = i;
    const names = [entries[i][1]];
    while (j + 1 < entries.length && entries[j + 1][0] === entries[j][0] + 1) { j++; names.push(entries[j][1]); }
    diff += `${entries[i][0]} ${names.map((n) => `/${n}`).join(" ")} `;
    i = j + 1;
  }
  return Buffer.from(`<< /Type /Font /Subtype /Type1 /BaseFont /${baseFont} /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [${diff.trim()}] >> >>`, "latin1");
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
  // Fail fast, never silently mangle: an unrepresentable name
  // (or a Polish/Latin-1 code collision) is an explainable error,
  // not a prepared "?" file.
  assertPdfRepresentable(content);
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
  // Polish glyphs actually present, for the fonts' /Differences.
  const usedPolish = new Set();
  const collectPolish = (text) => {
    for (const ch of String(text ?? "")) if (POLISH_MAP[ch] !== undefined) usedPolish.add(ch);
  };
  collectPolish(content.title);
  for (const section of content.sections || []) {
    collectPolish(section.heading);
    for (const l of section.lines || []) collectPolish(l.text);
  }
  objects[fontId] = pdfFontObject("Helvetica", usedPolish);
  objects[fontId + 1] = pdfFontObject("Helvetica-Bold", usedPolish);
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
