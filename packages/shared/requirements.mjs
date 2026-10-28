// F4 T-V2-036 (RF-V2-044, RF-V2-040): requirement assessment and
// multi-profile comparison.
//
// Binding inputs: ONLY the profile's own fields + presentedHistory
// (via the profileView built by search-run.mjs) + resolved declared
// facts referenced by that profile. The whole person history is never
// an input here: a profileView carries presentedEmployment /
// presentedEducation, and this module reads nothing else.
// Gaps are NEVER turned into fictitious experience and NEVER hidden
// by raising a score: a gap contributes exactly 0 to the assessment
// score, and the gaps list is returned alongside the score, not
// folded into it.

import { randomUUID } from "node:crypto";
import { wholeWordMatch } from "./search-presets.mjs";
import { scoreOffer } from "./search-rank.mjs";

const MANDATORY_MARKERS = [
  /\bmust\b/i, /\brequired\b/i, /\bessential\b/i, /\bmandatory\b/i,
  /\bminimum\b/i, /obligatorio/i, /imprescindible/i, /requisito/i,
  /se requiere/i, /es necesario/i,
];
const DESIRABLE_MARKERS = [
  /nice to have/i, /\bdesirable\b/i, /\bpreferred\b/i, /\bplus\b/i,
  /a plus/i, /deseable/i, /valorable/i, /se valorar[aá]/i, /ideal/i,
];

function norm(v) {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/** Split free text into requirement candidates (bullets, then sentences). */
export function splitRequirements(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const lines = raw.split(/\n|•|- |\* /).map((s) => s.trim()).filter(Boolean);
  const pieces = [];
  for (const line of lines) {
    // A bullet line may still pack several sentences; split long ones.
    const sentences = line.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    pieces.push(...(sentences.length > 1 && line.length > 120 ? sentences : [line]));
  }
  return pieces
    .filter((p) => p.length >= 8)
    .map((p) => {
      const kind = MANDATORY_MARKERS.some((re) => re.test(p))
        ? "mandatory"
        : DESIRABLE_MARKERS.some((re) => re.test(p))
          ? "desirable"
          : "unknown";
      return { text: p, kind, evidence: `extracted from offer text (${kind} marker${kind === "unknown" ? " absent" : " present"})` };
    });
}

/**
 * Extract requirements from an offer: a structured `requirements`
 * array wins when present; otherwise the description is split.
 * @param {any} offer
 */
export function extractRequirements(offer) {
  if (Array.isArray(offer?.requirements) && offer.requirements.length > 0) {
    return offer.requirements.map((r) => {
      if (typeof r === "string") {
        const found = splitRequirements(r);
        return found[0] ?? { text: r, kind: "unknown", evidence: "offer requirements field" };
      }
      const kind = ["mandatory", "desirable", "unknown"].includes(r?.kind) ? r.kind : "unknown";
      return { text: String(r?.text ?? ""), kind, evidence: r?.evidence ?? "offer requirements field" };
    }).filter((r) => r.text.trim());
  }
  return splitRequirements(offer?.description ?? "");
}

function presentedTexts(profileView) {
  const jobs = profileView?.presentedEmployment ?? [];
  const edu = profileView?.presentedEducation ?? [];
  return {
    jobTitles: jobs.map((j) => `${j.title ?? j.role ?? ""} ${j.employer ?? ""}`.trim()),
    jobTexts: jobs.map((j) => `${j.title ?? j.role ?? ""} ${j.employer ?? ""} ${j.description ?? ""}`.trim()),
    eduTexts: edu.map((e) => `${e.title ?? ""} ${e.institution ?? ""}`.trim()),
    skills: profileView?.fields?.skills ?? [],
    roles: profileView?.fields?.desired_roles ?? [],
  };
}

function yearsOfPresented(profileView) {
  let total = 0;
  let dated = false;
  for (const job of profileView?.presentedEmployment ?? []) {
    const start = job?.start ? new Date(`${job.start}-01`) : null;
    const end = job?.end ? new Date(`${job.end}-01`) : new Date();
    if (start && !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start) {
      total += (end.getTime() - start.getTime()) / (365.25 * 86400000);
      dated = true;
    }
  }
  return { total, dated };
}

/**
 * Contrast one requirement against profile evidence. Statuses:
 * "met" (evidence found), "gap" (evidence checked, requirement not
 * met), "unknown" (cannot be checked from the recorded evidence —
 * surfaced as a question, never guessed, never counted as met).
 * @param {{text: string, kind: string}} requirement
 * @param {any} profileView
 * @param {Array<{concept: string, scope?: string, value: unknown}>} [facts]
 */
export function contrastRequirement(requirement, profileView, facts = []) {
  const text = requirement.text;
  const hay = norm(text);
  const p = presentedTexts(profileView);
  const factTexts = (facts ?? []).map((f) => `${f.concept} ${f.scope ?? ""} ${typeof f.value === "string" ? f.value : JSON.stringify(f.value ?? "")}`);
  const allFactText = factTexts.join(" ");
  // Years-of-experience requirements are checked numerically against
  // PRESENTED employment only.
  const yearsMatch = hay.match(/(\d+)\s*\+?\s*(years?|años?)/);
  if (yearsMatch) {
    const needed = Number(yearsMatch[1]);
    const { total, dated } = yearsOfPresented(profileView);
    if (!dated) return { requirement, status: "unknown", evidence: "years of experience required, but presented employment has no usable dates" };
    if (total >= needed) return { requirement, status: "met", evidence: `presented experience ${total.toFixed(1)} years meets ${needed}+ years` };
    return { requirement, status: "gap", evidence: `presented experience ${total.toFixed(1)} years is below ${needed}+ years required` };
  }
  // Skill / role / education tokens: a whole-word hit in the
  // profile's own skills, presented jobs or presented education, or
  // in a resolved declared fact, counts as met.
  const tokens = [];
  for (const skill of p.skills) {
    if (wholeWordMatch(text, skill)) tokens.push(`skill "${skill}"`);
  }
  for (const role of p.roles) {
    if (wholeWordMatch(text, role)) tokens.push(`desired role "${role}"`);
  }
  for (const jobText of p.jobTexts) {
    if (jobText && wholeWordMatch(jobText, text.split(/\s+/).slice(0, 3).join(" "))) tokens.push(`presented employment "${jobText.slice(0, 60)}"`);
  }
  for (const eduText of p.eduTexts) {
    if (eduText && wholeWordMatch(eduText, text.split(/\s+/).slice(0, 3).join(" "))) tokens.push(`presented education "${eduText.slice(0, 60)}"`);
  }
  if (tokens.length > 0) return { requirement, status: "met", evidence: `matched: ${tokens.join("; ")}` };
  // A requirement naming a concrete skill the profile does not list
  // is a gap, not an unknown: the profile's skill list was checked.
  const knownSkillWords = p.skills.map(norm);
  const reqWords = hay.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  if (p.skills.length > 0 && reqWords.length > 0 && !reqWords.some((w) => knownSkillWords.includes(w))) {
    // Only call it a gap when the requirement looks like a skill-like
    // token (single concept phrase); vague prose stays unknown.
    if (reqWords.length <= 6) return { requirement, status: "gap", evidence: "no profile skill, presented job or presented education matches this requirement" };
  }
  if (allFactText && wholeWordMatch(allFactText, text)) return { requirement, status: "met", evidence: "matched a resolved declared fact for this profile" };
  return { requirement, status: "unknown", evidence: "cannot be confirmed from the profile's own fields, presented history or resolved facts — needs a question, not a guess" };
}

/**
 * Assess one offer for one profile view.
 * Score rule (auditable): score = number of mandatory requirements
 * met. Desirable met adds 0 to this score's mandatory count and is
 * reported separately; gaps add 0 and stay listed in `gaps`. Removing
 * a gap from the input therefore cannot change the score — the test
 * proves it.
 * @param {any} offer
 * @param {any} profileView
 * @param {Array<{concept: string, scope?: string, value: unknown}>} [facts]
 * @param {any} [criteria]
 */
export function assessOffer(offer, profileView, facts = [], criteria = {}) {
  const requirements = extractRequirements(offer);
  const contrasts = requirements.map((r) => contrastRequirement(r, profileView, facts));
  const mandatory = contrasts.filter((c) => c.requirement.kind === "mandatory");
  const desirable = contrasts.filter((c) => c.requirement.kind === "desirable");
  const unknownKind = contrasts.filter((c) => c.requirement.kind === "unknown");
  const gaps = contrasts.filter((c) => c.status === "gap");
  const mandatoryMet = mandatory.filter((c) => c.status === "met").length;
  const desirableMet = desirable.filter((c) => c.status === "met").length;
  const unknownStatus = contrasts.filter((c) => c.status === "unknown");
  let rank = null;
  try {
    const scored = scoreOffer(offer, profileView, criteria);
    rank = scored ? { total: scored.total, components: scored.components, needsReview: scored.needsReview } : { total: null, excluded: true };
  } catch {
    rank = { total: null, excluded: true };
  }
  return {
    profileId: profileView?.profileId ?? null,
    requirements,
    contrasts,
    mandatory: { total: mandatory.length, met: mandatoryMet },
    desirable: { total: desirable.length, met: desirableMet },
    unknownRequirements: unknownKind.length,
    unknownStatus: unknownStatus.length,
    gaps: gaps.map((g) => ({ text: g.requirement.text, kind: g.requirement.kind, evidence: g.evidence })),
    // Gaps contribute 0: score counts mandatory met only.
    score: mandatoryMet,
    rank,
  };
}

/**
 * Compare one offer across several profile views: each profile's
 * assessment + recommendation. Best = highest mandatory-met count,
 * tie-broken by rank total, then first profile. A profile whose rank
 * is excluded (hard fail) is not eligible for recommendation.
 * Nothing here creates an attempt or a document.
 * @param {any} offer
 * @param {any[]} profileViews
 * @param {{factsByProfile?: Record<string, any[]>, criteria?: any}} [opts]
 */
export function compareOfferProfiles(offer, profileViews, opts = {}) {
  if (!Array.isArray(profileViews) || profileViews.length === 0) throw new Error("profileViews must be a non-empty array");
  const assessments = profileViews.map((view) =>
    assessOffer(offer, view, opts.factsByProfile?.[view.profileId] ?? [], opts.criteria ?? {}));
  const eligible = assessments.filter((a) => a.rank && a.rank.total !== null);
  let bestProfileId = null;
  let bestScore = null;
  for (const a of eligible) {
    const key = [a.score, a.rank.total];
    if (bestScore === null || key[0] > bestScore[0] || (key[0] === bestScore[0] && key[1] > bestScore[1])) {
      bestScore = key; bestProfileId = a.profileId;
    }
  }
  const recommendation = bestProfileId
    ? { profileId: bestProfileId, reason: "highest mandatory requirements met, tie-broken by rank total; gaps remain listed and do not raise the score" }
    : { profileId: null, reason: "no profile is eligible for this offer (all hard-failed or unrankable)" };
  return { offerTitle: offer?.title ?? null, assessments, bestProfileId, recommendation };
}

// --- Missing facts become questions, never inferred facts -------------------
// For every assessment contrast with status "unknown" (the evidence
// was checked and cannot confirm the requirement), build a concrete
// question with purpose + scope. Gaps (status "gap") are NOT questions:
// they are known unmet requirements, and they stay open. Nothing here
// stores a fact, fills a gap by inference, or raises a score: the
// caller stores questions via askMissingFact (chat-tools.mjs), and the
// assessment itself is unchanged by asking.
function slug(text) {
  return String(text ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "requirement";
}

/**
 * @param {any} assessment assessOffer result
 * @returns {Array<{concept: string, scope: string, questionText: string, purpose: string, requirementText: string}>}
 */
export function questionsForAssessment(assessment) {
  const out = [];
  for (const contrast of assessment?.contrasts ?? []) {
    if (contrast.status !== "unknown") continue;
    const requirementText = contrast.requirement.text;
    out.push({
      concept: "assessment_requirement",
      scope: slug(requirementText),
      questionText: `Do you meet this requirement from the offer: "${requirementText}"? Please answer with evidence (experience, skill or qualification) or state that you do not meet it.`,
      purpose: `Needed to assess a mandatory/desirable offer requirement (${contrast.requirement.kind}) that cannot be confirmed from the profile's own fields, presented history or resolved facts.`,
      requirementText,
    });
  }
  return out;
}

// --- Persistence: one comparison per person per offer ----------------------
// The comparison records the CHOSEN profile. Choosing a different
// profile afterwards is a new decision, not a silent edit: recordComparison
// refuses a second comparison for the same person+offer with a
// different chosen profile, and the plan layer (application-plan.mjs)
// refuses to change a plan's profile. Document generation is a later
// phase and is deliberately NOT built here: no function in this module
// generates, renders or stores a document.

/** @param {any} db */
export function getComparison(db, personId, offerId) {
  const row = db.prepare("SELECT * FROM application_comparisons WHERE person_id = ? AND offer_id = ?").get(personId, offerId);
  if (!row) return null;
  return { ...row, assessments: JSON.parse(row.assessments_json) };
}

/**
 * Record a comparison, fixing the chosen profile for this person+offer.
 * Throws when an attempt already exists for this person+offer (one
 * attempt per person per offer), or when a comparison already fixed a
 * different profile.
 * @param {any} db
 */
export function recordComparison(db, { personId, offerId, chosenProfileId, assessments }) {
  if (!personId || !offerId || !chosenProfileId) throw new Error("personId, offerId and chosenProfileId are required");
  const attempt = db.prepare("SELECT id FROM attempts WHERE person_id = ? AND offer_id = ?").get(personId, offerId);
  if (attempt) throw new Error("an attempt already exists for this person and offer: one attempt per person per offer");
  const existing = getComparison(db, personId, offerId);
  if (existing) {
    if (existing.chosen_profile_id !== chosenProfileId) {
      throw new Error("comparison already fixed a different profile for this person and offer: the profile is fixed before document generation");
    }
    return existing.id;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO application_comparisons (id, person_id, offer_id, chosen_profile_id, assessments_json) VALUES (?, ?, ?, ?, ?)").run(
    id, personId, offerId, chosenProfileId, JSON.stringify(assessments ?? []),
  );
  return id;
}

/** Guard for plan creation: no attempt may already exist for person+offer. */
export function assertNoAttempt(db, personId, offerId) {
  const attempt = db.prepare("SELECT id FROM attempts WHERE person_id = ? AND offer_id = ?").get(personId, offerId);
  if (attempt) throw new Error("an attempt already exists for this person and offer: one attempt per person per offer");
}
