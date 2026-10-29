// F5 T-V2-041, T-V2-042, T-V2-043, T-V2-048 (RF-V2-017, 051, 052, 053,
// 054, 055, 061, 062, 095): semantic resolution over the RETAINED set
// (declared facts + verified aliases). Deterministic, no LLM, no
// guessing:
//  - a question is identified by concept + scope + polarity (negation).
//    Opposite questions never merge: polarity is part of the identity,
//    and a yes/no answer flips for a negated variant instead of being
//    answered from the shared words;
//  - one declaration resolves new paraphrase variants without another
//    literal question: after a VERIFIED resolution, the variant text is
//    stored as an alias (concept + scope + polarity + evidence fact),
//    and later variants hit the alias first;
//  - an alias is stored ONLY after a verified (declared) resolution
//    (RF-V2-055). Narrative text, LLM output and errors are NEVER
//    promoted to facts or aliases, and a failed resolution writes
//    nothing (see recordAlias / assertNotNarrative);
//  - conditional questions carry an EXPLICIT premise (concept + scope +
//    expected value). A missing premise is asked, an unmet premise
//    makes the question not-applicable; the last answer of another
//    group is never used as a premise (there is no last-answer state
//    anywhere in this module — premises arrive as inputs only);
//  - sensitive/voluntary concepts (criminal history, disability,
//    veteran status, ethnicity, references) are answered ONLY from an
//    explicit user declaration (or a disclose consent for that
//    concept). Otherwise the answer is a voluntary omission, never an
//    invented value and never a blocking question;
//  - history answers link to STABLE entry ids with their stored dates,
//    rendered at the precision actually held (year, year-month, or full
//    date — a day is never invented, RF-V2-061).
import { randomUUID } from "node:crypto";
import { normalizeConcept, resolveAnswer, resolveScreening } from "./resolve.mjs";
import { factsForConcept, getConfirmedFact } from "./facts.mjs";
import { hasConsent } from "./policies.mjs";

/** Concepts that may only be answered from an explicit user declaration. */
export const SENSITIVE_CONCEPTS = new Set([
  "criminal_history", "criminal_record", "disability_status", "disability",
  "veteran_status", "ethnicity", "race", "references_available", "references",
  "sexual_orientation", "religion", "political_opinion",
]);

// Keyword patterns for concept identification from free question text.
// Data, not inference: a pattern not listed here identifies no concept,
// and an unidentified concept is reported as needing a human, never
// guessed.
const CONCEPT_PATTERNS = [
  { concept: "work_authorisation", patterns: [/authori[sz]ed to work/, /work authori[sz]ation/, /work permit/, /legally (allowed|authori[sz]ed) to work/, /eligible to work/] },
  { concept: "sponsorship_required", patterns: [/sponsor/, /require sponsorship/, /need sponsorship/] },
  { concept: "salary_expectations", patterns: [/salary expect/, /expected salary/, /desired salary/, /compensation expect/, /salary.{0,25}expect/, /expect.{0,25}salary/] },
  { concept: "experience_years", patterns: [/years of experience/, /how many years/, /years[' ] experience/] },
  { concept: "english_level", patterns: [/english (level|proficiency|fluency)/, /level of english/] },
  { concept: "spanish_level", patterns: [/spanish (level|proficiency|fluency)/, /level of spanish/] },
  { concept: "desired_role", patterns: [/desired (role|position|job)/, /position (you )?(seek|want|desire)/, /target (role|job|position)/] },
  { concept: "current_location", patterns: [/current location/, /where (are you )?(based|located)/, /where do you live/] },
  { concept: "highest_education", patterns: [/highest (education|degree|qualification)/, /education level/] },
  { concept: "notice_period", patterns: [/notice period/, /how long (is|would) your notice/, /availability to start/] },
  { concept: "current_employment_status", patterns: [/currently employed/, /employment status/, /are you (currently )?working/] },
  { concept: "relocation_willingness", patterns: [/willing to relocat/, /relocation/, /willing to move/] },
  { concept: "criminal_history", patterns: [/criminal (history|record|conviction)/, /been convicted/] },
  { concept: "disability_status", patterns: [/disabilit/] },
  { concept: "veteran_status", patterns: [/veteran/] },
  { concept: "references_available", patterns: [/references( available)?/] },
];

const NEGATION_PATTERNS = [/\bnot\b/, /n't\b/, /\bnever\b/, /\bwithout\b/, /\bunable\b/, /\black of\b/, /\bno longer\b/];

const COUNTRY_NAMES = {
  spain: "ES", france: "FR", germany: "DE", italy: "IT", portugal: "PT",
  netherlands: "NL", belgium: "BE", austria: "AT", ireland: "IE",
  poland: "PL", "united kingdom": "GB", uk: "GB", "united states": "US", usa: "US",
  switzerland: "CH", sweden: "SE", norway: "NO", denmark: "DK", finland: "FI",
  greece: "GR", croatia: "HR", romania: "RO", bulgaria: "BG", hungary: "HU",
  czechia: "CZ", slovakia: "SK", slovenia: "SI", lithuania: "LT", latvia: "LV",
  estonia: "EE", cyprus: "CY", malta: "MT", luxembourg: "LU",
};

/** Normalize a question variant into an alias key (case, punctuation, spacing). */
export function normalizeVariant(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Identify concept, negation polarity and scope hint from free text.
 * Returns { concept: string|null, negated: boolean, scope: string }.
 * Scope is a hint only: an explicit scope argument always wins.
 */
export function parseQuestionText(text) {
  const lower = String(text ?? "").toLowerCase();
  let concept = null;
  for (const entry of CONCEPT_PATTERNS) {
    if (entry.patterns.some((re) => re.test(lower))) { concept = entry.concept; break; }
  }
  const negated = NEGATION_PATTERNS.some((re) => re.test(lower));
  let scope = "";
  const codes = lower.match(/\b[a-z]{2}\b/g) || [];
  const countryCodes = new Set(Object.values(COUNTRY_NAMES));
  for (const token of codes) {
    if (countryCodes.has(token.toUpperCase())) { scope = token.toUpperCase(); break; }
  }
  if (!scope) {
    for (const [name, c] of Object.entries(COUNTRY_NAMES)) {
      if (lower.includes(name)) { scope = c; break; }
    }
  }
  return { concept, negated, scope };
}

/** Provenance/text that may never become a fact or an alias. */
export function assertNotNarrative(input) {
  const text = typeof input === "string" ? input : (input?.provenance ?? input?.source ?? "");
  if (typeof text === "string" && /(llm|narrative|infer|model|generated)/i.test(text)) {
    throw new Error("narrative and LLM output are never facts: refusing to promote narrative text");
  }
}

/** Promoting narrative text to a permanent fact is always refused. */
export function promoteNarrativeToFact() {
  throw new Error("narrative text cannot be promoted to a personal fact (RF-V2-055)");
}

function flipYesNo(value) {
  if (value === "yes") return "no";
  if (value === "no") return "yes";
  return value;
}

function applyPolarity(answer, negated) {
  if (!negated || answer.kind !== "declared") return answer;
  if (answer.value === "yes" || answer.value === "no") {
    return { ...answer, value: flipYesNo(answer.value), polarityApplied: "negated question: yes/no value flipped", origin: "alias_or_fact" };
  }
  return { ...answer, polarityNoted: "negated question over a non-boolean value: value unchanged, polarity recorded", origin: "alias_or_fact" };
}

/**
 * Store an alias ONLY after a verified (declared) resolution.
 * Requires an evidence fact id that still resolves as confirmed;
 * otherwise throws and writes nothing. Errors never contaminate the base.
 */
export function recordAlias(db, personId, { variantText, concept, scope = "", negated = false, evidenceFactId }) {
  if (!variantText || !String(variantText).trim()) throw new Error("alias variant text is required");
  if (!evidenceFactId) throw new Error("alias requires a verified evidence fact id");
  const row = db.prepare("SELECT * FROM declared_facts WHERE id = ? AND person_id = ? AND concept = ? AND scope = ? AND confirmation_state = 'confirmed'").get(
    evidenceFactId, personId, normalizeConcept(concept), scope,
  );
  if (!row) throw new Error("alias evidence fact is not a confirmed declared fact for this concept and scope");
  const key = normalizeVariant(variantText);
  const existing = db.prepare("SELECT * FROM semantic_aliases WHERE person_id = ? AND variant_key = ?").get(personId, key);
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare(
    "INSERT INTO semantic_aliases (id, person_id, variant_key, variant_text, concept, scope, negated, evidence_fact_id, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)",
  ).run(id, personId, key, String(variantText), normalizeConcept(concept), scope, negated ? 1 : 0, evidenceFactId);
  return id;
}

export function listAliases(db, personId) {
  return db.prepare("SELECT * FROM semantic_aliases WHERE person_id = ? ORDER BY created_at ASC").all(personId).map((r) => ({
    ...r, negated: r.negated === 1,
  }));
}

function aliasFor(db, personId, variantText) {
  if (!variantText) return null;
  const row = db.prepare("SELECT * FROM semantic_aliases WHERE person_id = ? AND variant_key = ?").get(personId, normalizeVariant(variantText));
  return row ? { ...row, negated: row.negated === 1 } : null;
}

/**
 * Resolve one question semantically. Inputs: free text and/or an
 * explicit concept+scope, plus an optional explicit premise for
 * conditional questions. Returns a resolution with kind, value (when
 * declared), origin, references (fact ids) and, for missing answers,
 * the pending question id (a human question). No LLM, no guessing.
 */
export function resolveSemantic(db, personId, { text = "", concept = "", scope = "", premise = null } = {}) {
  const parsed = parseQuestionText(text);
  const normConcept = concept ? normalizeConcept(concept) : parsed.concept;
  const effScope = scope || parsed.scope || "";
  const negated = parsed.negated;
  // Conditional premise first: an explicit premise only, never a
  // leftover answer from another group. It is checked before the main
  // concept is even identified, so an unparsable main question cannot
  // bypass a missing premise.
  if (premise) {
    const pre = resolveAnswer(db, personId, { concept: premise.concept, scope: premise.scope ?? "" });
    if (pre.kind !== "declared") {
      return { kind: "needs_premise", premise, reason: "premise fact is not declared; ask the premise before answering" };
    }
    if (String(pre.value) !== String(premise.expected)) {
      return { kind: "not_applicable", premise, reason: "premise not met, so the conditional question does not apply" };
    }
  }
  if (!normConcept) {
    return { kind: "needs_human", reason: "concept could not be identified from the question text", text };
  }
  // Sensitive/voluntary: explicit user declaration or disclose consent
  // only; otherwise a voluntary omission, never an invented value and
  // never a blocking question.
  if (SENSITIVE_CONCEPTS.has(normConcept)) {
    const fact = getConfirmedFact(db, personId, normConcept, effScope);
    const disclosed = fact && (fact.provenance === "user" || hasConsent(db, personId, `disclose_${normConcept}`));
    if (disclosed) {
      return { kind: "declared", concept: normConcept, scope: effScope, value: fact.value, origin: "declared_sensitive", references: [fact.id] };
    }
    return { kind: "voluntary_omitted", concept: normConcept, scope: effScope, reason: "sensitive/voluntary concept without an explicit user declaration: omitted, never invented" };
  }
  // Alias hit: a previously verified variant resolves without a new
  // literal question. The variant text itself is the identity, and
  // polarity is part of it; the alias carries its resolved scope, so
  // a missing scope hint does not defeat the hit. An explicitly
  // supplied scope that conflicts with the alias still wins.
  const alias = aliasFor(db, personId, text);
  if (alias && alias.concept === normConcept && alias.negated === negated && (!scope || alias.scope === scope)) {
    const base = resolveAnswer(db, personId, { concept: alias.concept, scope: alias.scope });
    if (base.kind === "declared") {
      return applyPolarity({ ...base, origin: "alias", aliasId: alias.id, references: [alias.evidence_fact_id] }, negated);
    }
    // Alias evidence no longer resolves: do not answer from it.
    return { kind: "alias_stale", concept: normConcept, scope: effScope, aliasId: alias.id, reason: "alias evidence fact no longer resolves as declared" };
  }
  // Deterministic base resolution (declared / inference / ambiguous / missing).
  const base = resolveAnswer(db, personId, { concept: normConcept, scope: effScope });
  if (base.kind === "declared") {
    const fact = getConfirmedFact(db, personId, normConcept, effScope) ?? factsForConcept(db, personId, normConcept).find((f) => f.scope === base.scope);
    const resolved = applyPolarity({ ...base, origin: "declared", references: fact ? [fact.id] : [] }, negated);
    // Alias only AFTER this verified resolution (RF-V2-055), recorded
    // against the RESOLVED scope (the fact's own scope), so a later
    // variant with the same resolved scope hits it.
    if (text && text.trim()) {
      try { recordAlias(db, personId, { variantText: text, concept: normConcept, scope: base.scope ?? effScope, negated, evidenceFactId: fact?.id }); } catch { /* alias is a cache: never fail a verified answer for it */ }
    }
    return resolved;
  }
  if (base.kind === "missing") {
    const screened = resolveScreening(db, personId, [{ concept: normConcept, scope: effScope, questionText: text || undefined }]);
    return { ...base, origin: "missing", pendingQuestionId: screened[0].pendingQuestionId, questionText: screened[0].questionText };
  }
  return { ...base, origin: base.kind };
}

// --- History anchors (T-V2-042 / RF-V2-053, RF-V2-061) -----------------

/** Precision held by a stored date string: year, year-month, or full date. */
export function datePrecision(dateStr) {
  const s = String(dateStr ?? "").trim();
  if (/^\d{4}$/.test(s)) return "year";
  if (/^\d{4}-\d{2}$/.test(s)) return "year-month";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "date";
  return "unknown";
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Render a stored date at exactly its held precision — never invent a day. */
export function formatDateAtPrecision(dateStr) {
  const s = String(dateStr ?? "").trim();
  const precision = datePrecision(s);
  if (precision === "year") return s;
  if (precision === "year-month") {
    const [y, m] = s.split("-");
    const idx = Number(m) - 1;
    return idx >= 0 && idx < 12 ? `${MONTH_NAMES[idx]} ${y}` : s;
  }
  if (precision === "date") {
    const [y, m, d] = s.split("-");
    const idx = Number(m) - 1;
    return idx >= 0 && idx < 12 ? `${MONTH_NAMES[idx]} ${Number(d)}, ${y}` : s;
  }
  return s;
}

/** Render a stored entry's range at held precision ("Present" for open ends). */
export function formatDateRange(entry) {
  const start = entry?.start ? formatDateAtPrecision(entry.start) : "";
  const end = entry?.end ? formatDateAtPrecision(entry.end) : "Present";
  return start ? `${start} – ${end}` : end;
}

/** Resolve one history entry by its STABLE id (never by position alone). */
export function resolveHistoryEntry(entries, entryId) {
  const list = entries || [];
  const found = list.find((e) => e.id === entryId);
  if (!found) return { kind: "missing", entryId, reason: "no history entry with that stable id" };
  return { kind: "linked", entry: found, dateRange: formatDateRange(found) };
}

/**
 * Fill repeated history slots from held entries only. When a portal
 * asks for more entries than exist, report the impediment — never
 * fabricate entries and never let one entry contaminate another slot.
 */
export function fillHistorySlots(entries, requiredCount) {
  const list = entries || [];
  const slots = list.slice(0, requiredCount).map((entry) => ({ kind: "linked", entry, dateRange: formatDateRange(entry) }));
  const impediment = requiredCount > list.length
    ? `portal asks for ${requiredCount} entries but only ${list.length} exist; ask the user or declare the impediment`
    : null;
  return { slots, impediment, filled: slots.length, required: requiredCount };
}

// --- Evaluation (T-V2-048 / RF-V2-095) ---------------------------------

/**
 * Audit resolved answers against the retained set: every declared
 * answer must reference a confirmed fact with the same concept/scope
 * and the same value (or its yes/no flip for a negated question).
 * Returns the contamination count (must be 0) and per-answer verdicts.
 */
export function auditResolvedAnswers(db, personId, answers) {
  let contamination = 0;
  const verdicts = (answers || []).map((a) => {
    if (a.kind !== "declared") return { ok: true, kind: a.kind, reason: "not a factual claim" };
    const refs = a.references || [];
    const ok = refs.some((id) => {
      const row = db.prepare("SELECT * FROM declared_facts WHERE id = ? AND person_id = ? AND confirmation_state = 'confirmed'").get(id, personId);
      if (!row) return false;
      if (row.concept !== a.concept) return false;
      if (row.scope !== a.scope) return false;
      let value;
      try { value = JSON.parse(row.value_json); } catch { return false; }
      return value === a.value || (a.polarityApplied && ((value === "yes" && a.value === "no") || (value === "no" && a.value === "yes")));
    });
    if (!ok) contamination += 1;
    return { ok, kind: a.kind, concept: a.concept, reason: ok ? "references a confirmed fact" : "no confirmed fact backs this answer" };
  });
  return { contamination, verdicts };
}

/**
 * Evaluate semantic resolution over a batch of ATS paraphrase cases.
 * Measures human questions (new pending questions created during the
 * batch) and proves zero contamination. Cases: { text, concept?,
 * scope?, premise? }. A second variant of an already-declared concept
 * must not create another human question.
 */
export function evaluateSemantic(db, personId, cases) {
  const before = db.prepare("SELECT COUNT(*) AS n FROM pending_questions WHERE person_id = ? AND status = 'pending'").get(personId).n;
  const answers = (cases || []).map((c) => resolveSemantic(db, personId, c));
  const after = db.prepare("SELECT COUNT(*) AS n FROM pending_questions WHERE person_id = ? AND status = 'pending'").get(personId).n;
  // A human question is a new pending question OR a question whose
  // concept could not be identified at all (it must go to the user).
  // A paraphrase variant resolved from a declaration is neither.
  const audit = auditResolvedAnswers(db, personId, answers);
  const counts = { total: answers.length, declared: 0, viaAlias: 0, missing: 0, ambiguous: 0, voluntaryOmitted: 0, notApplicable: 0, needsPremise: 0, other: 0 };
  for (const a of answers) {
    if (a.kind === "declared" && a.origin === "alias") counts.viaAlias += 1;
    else if (a.kind === "declared") counts.declared += 1;
    else if (a.kind === "missing") counts.missing += 1;
    else if (a.kind === "ambiguous") counts.ambiguous += 1;
    else if (a.kind === "voluntary_omitted") counts.voluntaryOmitted += 1;
    else if (a.kind === "not_applicable") counts.notApplicable += 1;
    else if (a.kind === "needs_premise") counts.needsPremise += 1;
    else counts.other += 1;
  }
  return {
    ...counts,
    humanQuestionsCreated: (after - before) + answers.filter((a) => a.kind === "needs_human").length,
    contamination: audit.contamination,
    answers, auditVerdicts: audit.verdicts,
  };
}
