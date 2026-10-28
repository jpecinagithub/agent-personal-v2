// Pliego F3 T-V2-024 (RF-V2-023, RF-V2-024, RF-V2-025, RF-V2-026,
// RF-V2-027): the offer filter engine and unknown policies.
//
// Eligibility is decided BEFORE ranking (03 §6): hard exclusions
// prevail over any score. Every criterion reports
// { status: pass | fail | unknown | not_applicable, evidence }
// and, for tri-state criteria, its unknown policy.
//
// Standing rules:
// - Remote is allowed ONLY from a listed remote country. Remote with
//   an unknown country is `unknown`, never "worldwide" (RF-V2-023).
// - Salaries compare ONLY with the same currency AND period;
//   anything else is `unknown`. An unpublished salary follows the
//   criterion's unknownPolicy: review | exclude | include (RF-V2-025).
// - Authorisation, sponsorship and relocation are yes/no/unknown
//   tri-states; absence of information is never "available"
//   (RF-V2-026). Critical unknowns set needsReview and canAutoApply
//   is false; they are never counted as matches.
// - Non-English main content is a hard exclusion (RF-V2-027).
// - A missing value is `unknown`, never zero and never a pass.
import { wholeWordMatch, evaluateAst } from "./search-presets.mjs";
import { canonicalId } from "./search-dedupe.mjs";

/**
 * Offer shape (shared with the connectors worker, verbatim):
 * { source, ats, tenant, postingId, canonicalUrl, applyUrl, title,
 *   company, location: { country, region, city, raw, remote },
 *   workMode: remote|hybrid|onsite|unknown, seniority, contractType,
 *   workingTime, sector, description, skills: [],
 *   salary: { min, max, currency, period, published }, language,
 *   sponsorship: yes|no|unknown, relocation: yes|no|unknown,
 *   publishedAt: string|null, firstSeenAt, evidence: {} }
 * Optional extras honoured when present: status ('closed'|'expired'
 * is a hard exclusion), closedReason.
 */

const HARD = true;

function crit(status, evidence, hard = false) {
  return { status, evidence, hard };
}

function norm(v) {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function normList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((v) => norm(v)).filter(Boolean);
}

function isUnknown(v) {
  return v === undefined || v === null || (typeof v === "string" && (v.trim() === "" || v.trim().toLowerCase() === "unknown"));
}

/** Tri-state value of an offer field: 'yes' | 'no' | 'unknown'. */
function triState(v) {
  const n = norm(v);
  if (n === "yes") return "yes";
  if (n === "no") return "no";
  return "unknown";
}

/**
 * Apply an unknown policy. 'review' -> unknown + needs review;
 * 'exclude' -> fail; 'include' -> pass (recorded as a policy pass,
 * never as observed evidence).
 * @param {string} policy
 * @param {string} evidence
 * @returns {any}
 */
function applyUnknownPolicy(policy, evidence) {
  if (policy === "exclude") return crit("fail", `${evidence} (unknown policy: exclude)`);
  if (policy === "include") return crit("pass", `${evidence} (unknown policy: include — treated as passing, not as observed)`);
  return crit("unknown", `${evidence} (unknown policy: review)`);
}

function listCriterion(name, offerValue, allowed, hard = false) {
  if (!Array.isArray(allowed) || allowed.length === 0) return crit("not_applicable", `${name}: no criterion set`);
  if (isUnknown(offerValue)) return crit("unknown", `${name}: offer value unknown`);
  const ok = normList(allowed).includes(norm(offerValue));
  return crit(ok ? "pass" : "fail", ok ? `${name}: ${offerValue} is allowed` : `${name}: ${offerValue} is not in [${allowed.join(", ")}]`, hard);
}

/** Read the profile's authorisation map from any accepted shape. */
function authorisationMap(profileView) {
  if (!profileView || typeof profileView !== "object") return {};
  return profileView.authorisationByCountry
    ?? profileView.authorisations
    ?? profileView.fields?.authorisations
    ?? profileView.fields?.authorisationByCountry
    ?? {};
}

function salaryCriterion(offer, salary) {
  if (!salary || typeof salary !== "object") return crit("not_applicable", "salary: no criterion set");
  const policy = salary.unknownPolicy ?? "review";
  const os = offer.salary ?? {};
  if (os.published === false || (os.min === undefined && os.max === undefined && os.published !== true)) {
    return applyUnknownPolicy(policy, "salary: not published");
  }
  if (salary.currency && os.currency && norm(salary.currency) !== norm(os.currency)) {
    return crit("unknown", `salary: currency differs (${os.currency} vs ${salary.currency}) — not compared`);
  }
  if (salary.period && os.period && norm(salary.period) !== norm(os.period)) {
    return crit("unknown", `salary: period differs (${os.period} vs ${salary.period}) — not compared without a configured conversion`);
  }
  if ((salary.currency && !os.currency) || (salary.period && !os.period)) {
    return crit("unknown", "salary: offer currency/period unknown — not compared");
  }
  // Definite incompatibility first; partial ranges that cannot rule
  // the offer out stay unknown rather than being guessed.
  if (typeof salary.min === "number" && typeof os.max === "number" && os.max < salary.min) {
    return crit("fail", `salary: offer maximum ${os.max} is below required minimum ${salary.min}`);
  }
  if (typeof salary.max === "number" && typeof os.min === "number" && os.min > salary.max) {
    return crit("fail", `salary: offer minimum ${os.min} is above required maximum ${salary.max}`);
  }
  if (typeof salary.min === "number" && typeof os.min === "number" && typeof os.max === "number"
    && typeof salary.max === "number") {
    return crit("pass", "salary: ranges overlap");
  }
  if (typeof salary.min === "number" && typeof os.min === "number" && os.min >= salary.min
    && salary.max === undefined) {
    return crit("pass", "salary: offer minimum meets required minimum");
  }
  if (typeof salary.max === "number" && typeof os.max === "number" && os.max <= salary.max
    && salary.min === undefined) {
    return crit("pass", "salary: offer maximum within required maximum");
  }
  return crit("unknown", "salary: range only partially known — cannot confirm compatibility");
}

function skillsMatch(offer, skill) {
  const hay = [...(offer.skills ?? [])].join(" ");
  if (normList(offer.skills ?? []).includes(norm(skill))) return true;
  return wholeWordMatch(offer.description ?? "", skill) || wholeWordMatch(hay, skill);
}

function titleMatches(offer, wanted) {
  // A wanted title matches as a phrase (whole-word edges) or as a
  // whole-word term; "Sales" never matches "Salesforce".
  return wholeWordMatch(offer.title ?? "", wanted);
}

/**
 * Evaluate one offer against criteria (and, for authorisation, a
 * profile view). Criteria fields are all optional; an absent field
 * is not_applicable. Returns per-criterion results plus the overall
 * verdict. `canAutoApply` is false whenever any critical unknown
 * needs review, a criterion fails, or a hard exclusion applies.
 * @param {any} offer
 * @param {any} [criteria]
 * @param {any} [profileView]
 * @returns {{perCriterion: Record<string, any>, eligible: boolean, needsReview: boolean, canAutoApply: boolean, hardFailed: string[], failed: string[], unknowns: string[]}}
 */
/**
 * Sponsorship requirement derived from the profile view actually used
 * by the pipeline (never a silent not_applicable when the person
 * needs sponsorship): per-country when the offer country is known
 * and the person has an authorisation entry there, otherwise the
 * person's global sponsorship need. An explicit criterion always
 * wins. Relocation mirrors this: a local-only mobility explicitly
 * needs no relocation support; any other mobility value invents no
 * requirement — one must come from an explicit criterion.
 */
function effectiveSponsorshipSpec(c, view, offer) {
  if (c.sponsorship !== undefined && c.sponsorship !== null) return c.sponsorship;
  const policy = c.sponsorshipUnknownPolicy ?? c.sponsorshipUnknown ?? "review";
  const map = view?.sponsorshipRequiredByCountry ?? {};
  const country = offer?.location?.country;
  if (country) {
    const key = String(country).toUpperCase();
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      return map[key] ? { required: true, unknownPolicy: policy } : { required: false };
    }
  }
  if (view?.sponsorshipRequired === true) return { required: true, unknownPolicy: policy };
  return undefined;
}

function effectiveRelocationSpec(c, view) {
  if (c.relocation !== undefined && c.relocation !== null) return c.relocation;
  if (view?.mobility === "local") return { required: false };
  return undefined;
}

export function evaluateOffer(offer, criteria = {}, profileView = null) {
  const c = criteria ?? {};
  const perCriterion = {};
  const text = `${offer?.title ?? ""}\n${offer?.description ?? ""}`;

  // --- Status / already-sent / pending equivalence (hard) ---
  if (offer?.status === "closed" || offer?.status === "expired") {
    perCriterion.status = crit("fail", `offer status is ${offer.status}`, HARD);
  } else if (offer?.status) {
    perCriterion.status = crit("pass", `offer status: ${offer.status}`);
  } else {
    perCriterion.status = crit("not_applicable", "status: no status recorded");
  }
  if (Array.isArray(c.sentCanonicalIds) && c.sentCanonicalIds.length > 0) {
    const id = canonicalId(offer);
    perCriterion.alreadySent = id && c.sentCanonicalIds.includes(id)
      ? crit("fail", "offer was already sent by this person (canonical identity)", HARD)
      : crit("pass", "offer was not already sent");
  }
  if (Array.isArray(c.pendingCanonicalIds) && c.pendingCanonicalIds.length > 0) {
    const id = canonicalId(offer);
    perCriterion.pendingEquivalence = id && c.pendingCanonicalIds.includes(id)
      ? crit("fail", "offer has a pending equivalence — never auto-sendable (RF-V2-077)", HARD)
      : crit("pass", "no pending equivalence recorded");
  }

  // --- Language: non-English main content is a hard exclusion ---
  if (c.language) {
    if (isUnknown(offer?.language)) {
      perCriterion.language = crit("unknown", "language: offer language unknown");
    } else if (norm(offer.language) === norm(c.language)) {
      perCriterion.language = crit("pass", `language: ${offer.language}`);
    } else {
      perCriterion.language = crit("fail", `language: offer is ${offer.language}, required ${c.language}`, HARD);
    }
  }

  // --- Titles: included (any match) / excluded (hard) ---
  if (c.titles) {
    const wanted = Array.isArray(c.titles) ? c.titles : c.titles.any;
    const excluded = Array.isArray(c.titles) ? [] : (c.titles.exclude ?? []);
    const hitExcluded = excluded.find((t) => titleMatches(offer, t));
    if (hitExcluded) {
      perCriterion.titles = crit("fail", `title matches excluded title: ${hitExcluded}`, HARD);
    } else if (Array.isArray(wanted) && wanted.length > 0) {
      const hit = wanted.find((t) => titleMatches(offer, t));
      perCriterion.titles = hit
        ? crit("pass", `title matches wanted title: ${hit}`)
        : crit("fail", `title "${offer?.title ?? ""}" matches none of [${wanted.join(", ")}]`);
    } else {
      perCriterion.titles = crit("pass", "titles: no excluded title matched");
    }
  }
  if (Array.isArray(c.excludedTitles) && c.excludedTitles.length > 0) {
    const hit = c.excludedTitles.find((t) => titleMatches(offer, t));
    if (hit) perCriterion.excludedTitles = crit("fail", `title matches excluded title: ${hit}`, HARD);
    else if (!perCriterion.titles) perCriterion.excludedTitles = crit("pass", "no excluded title matched");
  }

  // --- Boolean title AST: it participates in filtering, it is not a
  // stored label. A title the AST rejects is a hard exclusion, so
  // NOT Junior excludes "Finance Manager Junior" (whole-word match
  // inside evaluateAst; phrases match as phrases).
  if (c.titleAst !== undefined && c.titleAst !== null) {
    let matches = false;
    try {
      matches = evaluateAst(c.titleAst, offer?.title ?? "");
    } catch {
      matches = false;
    }
    perCriterion.titleAst = matches
      ? crit("pass", "title matches the boolean expression")
      : crit("fail", "title does not match the boolean expression", HARD);
  }

  // --- Geography and mode ---
  const loc = offer?.location ?? {};
  if (Array.isArray(c.countries) && c.countries.length > 0) {
    if (isUnknown(loc.country)) perCriterion.countries = crit("unknown", "country: offer country unknown");
    else if (normList(c.countries).includes(norm(loc.country))) perCriterion.countries = crit("pass", `country: ${loc.country}`);
    else perCriterion.countries = crit("fail", `country: ${loc.country} not in [${c.countries.join(", ")}]`);
  }
  if (Array.isArray(c.regions) && c.regions.length > 0) {
    if (isUnknown(loc.region)) perCriterion.regions = crit("unknown", "region: offer region unknown");
    else if (normList(c.regions).includes(norm(loc.region))) perCriterion.regions = crit("pass", `region: ${loc.region}`);
    else perCriterion.regions = crit("fail", `region: ${loc.region} not in [${c.regions.join(", ")}]`);
  }
  if (Array.isArray(c.cities) && c.cities.length > 0) {
    if (isUnknown(loc.city)) perCriterion.cities = crit("unknown", "city: offer city unknown");
    else if (normList(c.cities).includes(norm(loc.city))) perCriterion.cities = crit("pass", `city: ${loc.city}`);
    else perCriterion.cities = crit("fail", `city: ${loc.city} not in [${c.cities.join(", ")}]`);
  }
  if (Array.isArray(c.workModes) && c.workModes.length > 0) {
    perCriterion.workModes = listCriterion("workMode", offer?.workMode, c.workModes);
  }
  // Remote geo-restriction: applies only to remote offers. Remote
  // with an unknown country is unknown, never worldwide.
  if (norm(offer?.workMode) === "remote" || loc.remote === true) {
    if (Array.isArray(c.remoteCountries) && c.remoteCountries.length > 0) {
      if (isUnknown(loc.country)) {
        perCriterion.remoteCountries = crit("unknown", "remote: offer country unknown — remote is not assumed worldwide");
      } else if (normList(c.remoteCountries).includes(norm(loc.country))) {
        perCriterion.remoteCountries = crit("pass", `remote: ${loc.country} is a listed remote country`);
      } else {
        perCriterion.remoteCountries = crit("fail", `remote: ${loc.country} is not a listed remote country`);
      }
    } else {
      perCriterion.remoteCountries = crit("not_applicable", "remoteCountries: no remote-country list configured");
    }
  } else {
    perCriterion.remoteCountries = crit("not_applicable", "remoteCountries: offer is not remote");
  }

  // --- Job attributes ---
  perCriterion.seniority = listCriterion("seniority", offer?.seniority, c.seniority);
  perCriterion.contractType = listCriterion("contractType", offer?.contractType, c.contractTypes ?? c.contractType);
  perCriterion.workingTime = listCriterion("workingTime", offer?.workingTime, c.workingTime);
  perCriterion.sector = listCriterion("sector", offer?.sector, c.sectors ?? c.sector);

  // --- Companies: blocked / excluded are hard; include is a filter ---
  if (c.companies) {
    const blocked = normList(c.companies.blocked ?? []);
    const excluded = normList(c.companies.exclude ?? []);
    const included = normList(c.companies.include ?? []);
    const priority = normList(c.companies.priority ?? []);
    const name = norm(offer?.company);
    if (blocked.includes(name)) {
      perCriterion.companies = crit("fail", `company ${offer.company} is blocked`, HARD);
    } else if (excluded.includes(name)) {
      perCriterion.companies = crit("fail", `company ${offer.company} is excluded`, HARD);
    } else if (included.length > 0 && !included.includes(name)) {
      perCriterion.companies = crit("fail", `company ${offer.company} is not in the included list`);
    } else {
      perCriterion.companies = crit("pass", priority.includes(name)
        ? `company ${offer.company} (priority)`
        : `company ${offer.company} is allowed`);
    }
  }

  // --- Skills: required (fail when absent), excluded (hard) ---
  if (Array.isArray(c.requiredSkills) && c.requiredSkills.length > 0) {
    const missing = c.requiredSkills.filter((s) => !skillsMatch(offer, s));
    perCriterion.requiredSkills = missing.length === 0
      ? crit("pass", "all required skills present")
      : crit("fail", `missing required skills: ${missing.join(", ")}`);
  }
  if (Array.isArray(c.excludedSkills) && c.excludedSkills.length > 0) {
    const hit = c.excludedSkills.find((s) => skillsMatch(offer, s));
    perCriterion.excludedSkills = hit
      ? crit("fail", `excluded skill present: ${hit}`, HARD)
      : crit("pass", "no excluded skill present");
  }

  // --- Description terms (whole-word) ---
  if (Array.isArray(c.descriptionRequired) && c.descriptionRequired.length > 0) {
    const missing = c.descriptionRequired.filter((t) => !wholeWordMatch(text, t));
    perCriterion.descriptionRequired = missing.length === 0
      ? crit("pass", "all required description terms present")
      : crit("fail", `missing description terms: ${missing.join(", ")}`);
  }
  if (Array.isArray(c.descriptionExcluded) && c.descriptionExcluded.length > 0) {
    const hit = c.descriptionExcluded.find((t) => wholeWordMatch(text, t));
    perCriterion.descriptionExcluded = hit
      ? crit("fail", `excluded description term present: ${hit}`, HARD)
      : crit("pass", "no excluded description term present");
  }

  // --- Salary ---
  perCriterion.salary = salaryCriterion(offer, c.salary);

  // --- Tri-states: sponsorship / relocation (offer-side) ---
  const triCriterion = (name, offerValue, spec) => {
    if (spec === undefined || spec === null) return crit("not_applicable", `${name}: no criterion set`);
    let required;
    let policy = "review";
    if (typeof spec === "string") required = spec;
    else if (typeof spec === "object") { required = spec.required ?? spec.requires; policy = spec.unknownPolicy ?? "review"; }
    if (required === undefined || required === null) return crit("not_applicable", `${name}: no requirement set`);
    // `requires: true` means the offer must provide it; `requires:
    // false` means it is not needed and the criterion does not apply.
    if (required === false) return crit("not_applicable", `${name}: not required`);
    const want = required === true ? "yes" : norm(required);
    const got = triState(offerValue);
    if (got === "unknown") return applyUnknownPolicy(policy, `${name}: unknown`);
    if (got === want) return crit("pass", `${name}: ${got}`);
    // Sponsorship/relocation unavailable when required is a hard
    // block for an application that would need it.
    return crit("fail", `${name}: offer is ${got}, required ${want}`, HARD);
  };
  perCriterion.sponsorship = triCriterion("sponsorship", offer?.sponsorship, effectiveSponsorshipSpec(c, profileView, offer));
  perCriterion.relocation = triCriterion("relocation", offer?.relocation, effectiveRelocationSpec(c, profileView));

  // --- Authorisation (profile-side, by offer country) ---
  if (c.authorisation !== undefined && c.authorisation !== null) {
    const policy = typeof c.authorisation === "object" ? (c.authorisation.unknownPolicy ?? "review") : "review";
    const map = authorisationMap(profileView);
    if (isUnknown(loc.country)) {
      perCriterion.authorisation = crit("unknown", "authorisation: offer country unknown — cannot check work authorisation");
    } else {
      const raw = map[loc.country] ?? map[norm(loc.country)] ?? map[String(loc.country).toUpperCase()];
      const state = raw === undefined || raw === null ? "unknown" : triState(raw);
      if (state === "yes") perCriterion.authorisation = crit("pass", `authorisation: authorised in ${loc.country}`);
      else if (state === "no") perCriterion.authorisation = crit("fail", `authorisation: not authorised in ${loc.country}`, HARD);
      else perCriterion.authorisation = applyUnknownPolicy(policy, `authorisation: unknown for ${loc.country}`);
    }
  }

  // --- Publication recency / unknown date ---
  if (typeof c.publishedWithinDays === "number") {
    if (!offer?.publishedAt) {
      perCriterion.publishedWithin = crit("unknown", "publishedAt: publication date unknown — marked unknown, never assumed recent");
    } else {
      const published = new Date(offer.publishedAt);
      const ageDays = Number.isNaN(published.getTime())
        ? null
        : (Date.now() - published.getTime()) / 86400000;
      if (ageDays === null) perCriterion.publishedWithin = crit("unknown", "publishedAt: unparseable date");
      else if (ageDays <= c.publishedWithinDays) perCriterion.publishedWithin = crit("pass", `published ${ageDays.toFixed(0)} days ago`);
      else perCriterion.publishedWithin = crit("fail", `published ${ageDays.toFixed(0)} days ago, limit ${c.publishedWithinDays}`);
    }
  }

  const failed = [];
  const hardFailed = [];
  const unknowns = [];
  for (const [key, r] of Object.entries(perCriterion)) {
    if (r.status === "fail") {
      failed.push(key);
      if (r.hard) hardFailed.push(key);
    } else if (r.status === "unknown") {
      unknowns.push(key);
    }
  }
  const eligible = failed.length === 0;
  // Needs review: any unknown that was not explicitly included by
  // policy. Unknowns whose policy said "include" report status pass,
  // so they never appear here.
  const needsReview = unknowns.length > 0;
  const canAutoApply = eligible && !needsReview;
  return { perCriterion, eligible, needsReview, canAutoApply, hardFailed, failed, unknowns };
}
