// Pliego F3 T-V2-034 (RF-V2-038, RF-V2-039, RF-V2-040, RF-V2-095),
// BINDING: ranking and comparison by profile.
//
// The ranker receives ONLY a profileView:
//   { profileId, name, fields: { desired_roles, locations, skills,
//     exclusions, salary_expectations },
//     presentedEmployment: [...], presentedEducation: [...] }
// That is the output of presentedHistory() from profiles.mjs plus
// the profile's own fields. There is NO person-history parameter:
// a profile that hides financial experience ranks WITHOUT it, and
// two profiles over the same person, with different fields and
// selections, rank and compare differently. A test proves this.
//
// Weights sum to 100 (03 §7): role/seniority 30, relevant
// experience 25, skills 20, location/mode 15, preferences/recency 10.
// Scores are INTEGERS only — no false-precision decimals and no
// hiring probability. Every component reports { score, evidence,
// unknown }; unknowns are shown, never counted as matches. Hard-
// failed offers (search-filters) are excluded regardless of score.
// compareProfiles recommends a best profile per offer; it never
// applies and never auto-applies.
import { wholeWordMatch } from "./search-presets.mjs";
import { evaluateOffer } from "./search-filters.mjs";

export const RANK_WEIGHTS = {
  roleSeniority: 30, experience: 25, skills: 20, locationMode: 15, preferencesRecency: 10,
};
export const RANK_TOTAL = 100;

function norm(v) {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function normTitle(v) {
  return norm(v).replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();
}

const STOPWORDS = new Set(["and", "of", "the", "a", "an", "for", "in", "to", "head", "manager", "director", "lead", "senior", "junior"]);

function tokens(title) {
  return normTitle(title).split(" ").filter((t) => t && !STOPWORDS.has(t));
}

/** Parse a YYYY-MM or YYYY date; null when unparseable. */
function parseDate(value) {
  if (!value) return null;
  const m = /^(\d{4})(?:-(\d{2}))?/.exec(String(value).trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2] ?? 1) - 1, 1));
  return Number.isNaN(d.getTime()) ? null : d;
}

function yearsBetween(start, end, now) {
  const s = parseDate(start);
  if (!s) return null;
  const e = parseDate(end) ?? now;
  const years = (e.getTime() - s.getTime()) / (365.25 * 86400000);
  return years > 0 ? years : 0;
}

function component(score, evidence, unknown = false) {
  return { score: Math.trunc(score), evidence, unknown };
}

function roleScore(offer, profileView) {
  const desired = profileView?.fields?.desired_roles ?? [];
  const title = offer?.title ?? "";
  if (!title.trim()) return component(0, "role: offer title unknown", true);
  if (desired.length === 0) return component(0, "role: profile has no desired roles recorded", true);
  const titleNorm = normTitle(title);
  for (const role of desired) {
    if (titleNorm === normTitle(role)) return component(30, `role: title exactly matches desired role "${role}"`);
  }
  for (const role of desired) {
    if (wholeWordMatch(title, role)) return component(25, `role: title contains desired role "${role}"`);
  }
  // Token overlap on significant tokens.
  let best = 0;
  let bestRole = null;
  const offerTokens = new Set(tokens(title));
  for (const role of desired) {
    const roleTokens = tokens(role);
    if (roleTokens.length === 0) continue;
    const shared = roleTokens.filter((t) => offerTokens.has(t)).length;
    const ratio = shared / roleTokens.length;
    if (ratio > best) { best = ratio; bestRole = role; }
  }
  if (best >= 0.5) return component(15, `role: title shares significant tokens with desired role "${bestRole}"`);
  return component(0, `role: title "${title}" does not match desired roles [${desired.join(", ")}]`);
}

function experienceScore(offer, profileView, now) {
  const employment = profileView?.presentedEmployment ?? [];
  const education = profileView?.presentedEducation ?? [];
  // Relevance is to THIS offer (its title and listed skills), not to
  // the profile's desired roles in general: presented finance
  // experience must not inflate a Salesforce offer's experience score.
  const offerTokens = new Set([
    ...tokens(offer?.title ?? ""),
    ...(offer?.skills ?? []).flatMap((s) => tokens(s)),
  ]);
  const relevant = (entry) => {
    const entryTokens = new Set(tokens(entry?.title ?? entry?.role ?? ""));
    for (const t of entryTokens) {
      if (offerTokens.has(t)) return true;
    }
    return false;
  };
  if (employment.length === 0 && education.length === 0) {
    return component(0, "experience: profile presents no employment or education", true);
  }
  const relevantJobs = employment.filter(relevant);
  if (relevantJobs.length > 0) {
    let totalYears = 0;
    let dated = false;
    for (const job of relevantJobs) {
      const y = yearsBetween(job.start, job.end, now);
      if (y !== null) { totalYears += y; dated = true; }
    }
    const yearsText = dated ? `${totalYears.toFixed(1)} years of presented relevant experience` : "presented relevant experience (dates unknown)";
    if (!dated) return component(15, `${yearsText} — dates unknown, years not estimated`);
    if (totalYears >= 5) return component(25, yearsText);
    if (totalYears >= 3) return component(20, yearsText);
    if (totalYears >= 1) return component(15, yearsText);
    return component(10, yearsText);
  }
  const relevantEdu = education.filter(relevant);
  if (relevantEdu.length > 0) {
    return component(10, `experience: no presented relevant employment; relevant presented education: ${relevantEdu.map((e) => e.title ?? e.institution ?? "?").join(", ")}`);
  }
  return component(0, "experience: no presented employment or education matches this role");
}

function skillsScore(offer, profileView) {
  const skills = profileView?.fields?.skills ?? [];
  if (skills.length === 0) return component(0, "skills: profile has no skills recorded", true);
  const offerSkills = offer?.skills ?? [];
  const description = offer?.description ?? "";
  if (offerSkills.length === 0 && !description.trim()) {
    return component(0, "skills: offer lists no skills and has no description to check", true);
  }
  const matched = skills.filter((s) =>
    offerSkills.map((x) => norm(x)).includes(norm(s)) || wholeWordMatch(description, s));
  const score = Math.round((matched.length / skills.length) * 20);
  return component(score, matched.length > 0
    ? `skills: ${matched.length}/${skills.length} profile skills found in the offer (${matched.join(", ")})`
    : `skills: 0/${skills.length} profile skills found in the offer`);
}

function locationModeScore(offer, profileView, criteria) {
  const locations = profileView?.fields?.locations ?? [];
  const loc = offer?.location ?? {};
  let locationScore = 0;
  let locationEvidence = "";
  let unknown = false;
  const locNorm = normList(locations);
  if (locations.length === 0) {
    unknown = true;
    locationEvidence = "location: profile has no locations recorded";
  } else if (locNorm.includes(norm(loc.country)) || locNorm.includes(norm(loc.city))) {
    locationScore = 10;
    locationEvidence = `location: offer in ${loc.city ?? loc.country ?? "?"} matches a profile location`;
  } else if (locNorm.includes(norm(loc.region))) {
    locationScore = 7;
    locationEvidence = `location: offer region ${loc.region} matches a profile location`;
  } else if (norm(offer?.workMode) === "remote" && isUnknownCountry(loc.country)) {
    unknown = true;
    locationEvidence = "location: remote offer country unknown — not counted as a location match";
  } else {
    locationEvidence = `location: offer in ${loc.city ?? loc.country ?? "unknown place"} does not match profile locations [${locations.join(", ")}]`;
  }
  let modeScore = 0;
  let modeEvidence = "";
  const modes = criteria?.workModes ?? [];
  if (modes.length > 0) {
    if (isUnknownValue(offer?.workMode)) {
      unknown = true;
      modeEvidence = "mode: offer work mode unknown";
    } else if (normList(modes).includes(norm(offer.workMode))) {
      modeScore = 5;
      modeEvidence = `mode: ${offer.workMode} is an accepted mode`;
    } else {
      modeEvidence = `mode: ${offer.workMode} is not an accepted mode`;
    }
  } else {
    modeEvidence = "mode: no mode criterion set";
  }
  return component(locationScore + modeScore, `${locationEvidence}; ${modeEvidence}`, unknown);
}

function normList(list) {
  return (list ?? []).map((v) => norm(v)).filter(Boolean);
}

function isUnknownCountry(v) {
  return v === undefined || v === null || String(v).trim() === "" || String(v).trim().toLowerCase() === "unknown";
}

function isUnknownValue(v) {
  return isUnknownCountry(v);
}

function preferencesRecencyScore(offer, criteria, now) {
  let score = 0;
  const parts = [];
  let unknown = false;
  const priority = normList(criteria?.companies?.priority ?? []);
  if (priority.includes(norm(offer?.company))) {
    score += 4;
    parts.push(`priority company ${offer.company} (+4)`);
  }
  const sectors = normList(criteria?.sectors ?? criteria?.sector ?? []);
  if (sectors.length > 0 && sectors.includes(norm(offer?.sector))) {
    score += 3;
    parts.push(`sector ${offer.sector} matches (+3)`);
  }
  if (!offer?.publishedAt) {
    unknown = true;
    parts.push("publication date unknown — recency not counted");
  } else {
    const published = new Date(offer.publishedAt);
    if (Number.isNaN(published.getTime())) {
      unknown = true;
      parts.push("publication date unparseable — recency not counted");
    } else {
      const ageDays = (now.getTime() - published.getTime()) / 86400000;
      if (ageDays <= 7) { score += 3; parts.push("published within 7 days (+3)"); }
      else if (ageDays <= 30) { score += 2; parts.push("published within 30 days (+2)"); }
      else { score += 1; parts.push("published over 30 days ago (+1)"); }
    }
  }
  return component(score, parts.join("; ") || "preferences/recency: no preference or recency signal", unknown);
}

/**
 * Score one offer for one profile view. Returns null when the offer
 * is hard-failed by the filters (it is excluded regardless of score).
 * @param {any} offer
 * @param {any} profileView
 * @param {any} [criteria]
 * @param {{now?: Date | string}} [opts]
 * @returns {any | null}
 */
export function scoreOffer(offer, profileView, criteria = {}, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const verdict = evaluateOffer(offer, criteria, profileView);
  if (!verdict.eligible) return null;
  const components = {
    roleSeniority: roleScore(offer, profileView),
    experience: experienceScore(offer, profileView, now),
    skills: skillsScore(offer, profileView),
    locationMode: locationModeScore(offer, profileView, criteria),
    preferencesRecency: preferencesRecencyScore(offer, criteria, now),
  };
  const total = Object.values(components).reduce((sum, c) => sum + c.score, 0);
  return {
    offer,
    profileId: profileView?.profileId ?? null,
    total,
    components,
    needsReview: verdict.needsReview,
    canAutoApply: verdict.canAutoApply,
    unknowns: verdict.unknowns,
  };
}

/**
 * Rank offers for one profile view. Hard-failed offers are excluded
 * regardless of score and reported separately — they never appear
 * in `ranked`, whatever their title match would have been.
 * @param {any[]} offers
 * @param {any} profileView
 * @param {any} [criteria]
 * @param {{now?: Date | string}} [opts]
 * @returns {{ranked: any[], excluded: {offer: any, hardFailed: string[], failed: string[]}[]}}
 */
export function rankOffers(offers, profileView, criteria = {}, opts = {}) {
  if (!Array.isArray(offers)) throw new Error("offers must be an array");
  const ranked = [];
  const excluded = [];
  for (const offer of offers) {
    const verdict = evaluateOffer(offer, criteria, profileView);
    if (!verdict.eligible) {
      excluded.push({ offer, hardFailed: verdict.hardFailed, failed: verdict.failed });
      continue;
    }
    const scored = scoreOffer(offer, profileView, criteria, opts);
    if (scored) ranked.push(scored);
  }
  ranked.sort((a, b) => b.total - a.total);
  return { ranked, excluded };
}

/**
 * Compare the same offers across several profile views. Per offer,
 * per profile: total, components, eligibility and auto-appliability.
 * `bestProfileId` is the highest-scoring ELIGIBLE profile (first
 * profile wins ties); null when no profile is eligible for the offer.
 * No application is created and nothing is auto-applied.
 * @param {any[]} offers
 * @param {any[]} profileViews
 * @param {any} [criteria]
 * @param {{now?: Date | string}} [opts]
 * @returns {{results: {offer: any, scores: any[], bestProfileId: string | null, bestTotal: number | null}[]}}
 */
export function compareProfiles(offers, profileViews, criteria = {}, opts = {}) {
  if (!Array.isArray(offers)) throw new Error("offers must be an array");
  if (!Array.isArray(profileViews) || profileViews.length === 0) throw new Error("profileViews must be a non-empty array");
  const results = offers.map((offer) => {
    const scores = profileViews.map((view) => {
      const verdict = evaluateOffer(offer, criteria, view);
      if (!verdict.eligible) {
        return {
          profileId: view?.profileId ?? null, total: null, components: null,
          eligible: false, canAutoApply: false, hardFailed: verdict.hardFailed, failed: verdict.failed,
        };
      }
      const scored = scoreOffer(offer, view, criteria, opts);
      return {
        profileId: view?.profileId ?? null, total: scored.total, components: scored.components,
        eligible: true, canAutoApply: scored.canAutoApply, hardFailed: [], failed: [],
        needsReview: scored.needsReview, unknowns: scored.unknowns,
      };
    });
    const eligibleScores = scores.filter((s) => s.eligible && s.total !== null);
    let bestProfileId = null;
    let bestTotal = null;
    for (const s of eligibleScores) {
      if (bestTotal === null || s.total > bestTotal) { bestTotal = s.total; bestProfileId = s.profileId; }
    }
    return { offer, scores, bestProfileId, bestTotal };
  });
  return { results };
}

/**
 * Summarise a run (RF-V2-039, RF-V2-095). `results` is a per-source
 * array: { source, status, observed, valid, duplicates, excluded,
 * pending, cause }. `sources` is the list of source ids attempted.
 * Numerators and denominators only — never a universality
 * percentage. Coverage is complete only when every attempted source
 * completed; any failure makes it partial, with its cause listed.
 * @param {any[]} results
 * @param {string[]} sources
 * @returns {{attempted: number, completed: number, observed: number, valid: number, duplicates: number, excluded: number, pending: number, coverage: string, causes: {source: string, status: string, cause: string | null}[]}}
 */
export function summarizeRun(results, sources) {
  const attemptedList = Array.isArray(sources) ? sources : [];
  const perSource = Array.isArray(results) ? results : [];
  const bySource = new Map(perSource.map((r) => [r.source, r]));
  let completed = 0;
  let observed = 0;
  let valid = 0;
  let duplicates = 0;
  let excluded = 0;
  let pending = 0;
  const causes = [];
  for (const source of attemptedList) {
    const r = bySource.get(source);
    if (!r) {
      causes.push({ source, status: "unavailable", cause: "no result recorded for this source" });
      continue;
    }
    if (r.status === "completed" || r.status === "completed_zero_results") {
      completed += 1;
      observed += r.observed ?? 0;
      valid += r.valid ?? 0;
      duplicates += r.duplicates ?? 0;
      excluded += r.excluded ?? 0;
      pending += r.pending ?? 0;
    } else {
      causes.push({ source, status: r.status ?? "failed", cause: r.cause ?? null });
    }
  }
  // Sources that reported without being in the attempted list still
  // count toward the totals, but never toward coverage completion.
  for (const r of perSource) {
    if (!attemptedList.includes(r.source) && (r.status === "completed" || r.status === "completed_zero_results")) {
      observed += r.observed ?? 0;
      valid += r.valid ?? 0;
      duplicates += r.duplicates ?? 0;
      excluded += r.excluded ?? 0;
      pending += r.pending ?? 0;
    }
  }
  return {
    attempted: attemptedList.length,
    completed,
    observed, valid, duplicates, excluded, pending,
    coverage: attemptedList.length > 0 && completed === attemptedList.length ? "complete" : "partial",
    causes,
  };
}
