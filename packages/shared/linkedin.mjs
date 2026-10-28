// F3 LinkedIn, ASSISTED ONLY (T-V2-030, RF-V2-032, RF-V2-033).
//
// Hard limits, by design:
//   - NO login, NO crawl, NO automation, NO scraping of LinkedIn.
//   - This module only (a) builds search URLs from LinkedIn's own
//     supported public search parameters, for the USER to open in their
//     own browser, (b) saves links the user supplies, and (c) turns
//     user-supplied imports (a URL, pasted text, or a CSV) into
//     candidates with provenance, resolving each candidate to its
//     external ATS/company destination where possible.
//   - Easy Apply is NEVER executed here: every record this module
//     produces is labelled assisted, and LINKEDIN_ASSISTED.easyApplyExecuted
//     is always false. Applying happens, if at all, through the
//     external destination or by the user.
//   - A candidate's apply URL is never invented: importUrl resolves
//     through the injected extractOffer function (wired by the server),
//     and when extraction is unavailable the candidate stays
//     "pending_extraction" with no apply URL at all.
import { randomUUID } from "node:crypto";

/** Assisted mode marker: nothing in this module acts on a LinkedIn account. */
export const LINKEDIN_ASSISTED = Object.freeze({ mode: "assisted", easyApplyExecuted: false });

// LinkedIn's supported public jobs-search parameters (jobs/search).
// f_WT: 1 = onsite, 2 = remote, 3 = hybrid.
// f_JT: F = full-time, P = part-time, C = contract, T = temporary,
//       I = internship, V = volunteer, O = other.
// f_E: 1 = internship, 2 = entry, 3 = associate, 4 = mid-senior,
//      5 = director, 6 = executive.
// Values outside these maps are OMITTED, never guessed into a code.
const WORK_MODE_PARAMS = { onsite: "1", remote: "2", hybrid: "3" };
const JOB_TYPE_PARAMS = {
  "full-time": "F",
  fulltime: "F",
  "part-time": "P",
  parttime: "P",
  contract: "C",
  temporary: "T",
  internship: "I",
  volunteer: "V",
  other: "O",
};
const EXPERIENCE_PARAMS = {
  internship: "1",
  entry: "2",
  junior: "2",
  associate: "3",
  "mid-senior": "4",
  senior: "4",
  director: "5",
  executive: "6",
};

function nowIso() {
  return new Date().toISOString();
}

/**
 * Build a LinkedIn jobs search URL from supported public parameters
 * only. Unsupported filter values are dropped, not mapped by guesswork.
 * @param {{keywords?: string, location?: string, workMode?: string, jobType?: string, experience?: string}} filters
 */
export function buildSearchUrl({ keywords, location, workMode, jobType, experience } = {}) {
  const params = new URLSearchParams();
  if (keywords) params.set("keywords", keywords);
  if (location) params.set("location", location);
  if (workMode && WORK_MODE_PARAMS[workMode]) params.set("f_WT", WORK_MODE_PARAMS[workMode]);
  if (jobType && JOB_TYPE_PARAMS[jobType]) params.set("f_JT", JOB_TYPE_PARAMS[jobType]);
  if (experience && EXPERIENCE_PARAMS[experience]) params.set("f_E", EXPERIENCE_PARAMS[experience]);
  const query = params.toString();
  return query ? `https://www.linkedin.com/jobs/search/?${query}` : "https://www.linkedin.com/jobs/search/";
}

/**
 * Save a user-supplied LinkedIn link for assisted follow-up. The URL
 * must be a LinkedIn URL; anything else is rejected, not stored.
 * @param {string} url
 * @param {{title?: string|null, note?: string|null}} meta
 */
export function saveLink(url, { title = null, note = null } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid LinkedIn URL");
  }
  if (parsed.protocol !== "https:") throw new Error("only https: LinkedIn URLs can be saved");
  if (parsed.hostname !== "linkedin.com" && !parsed.hostname.endsWith(".linkedin.com")) throw new Error("not a LinkedIn URL");
  return {
    id: randomUUID(),
    url,
    title,
    note,
    savedAt: nowIso(),
    mode: "assisted",
    provenance: "linkedin-assisted",
    easyApplyExecuted: false,
  };
}

/**
 * Import one user-supplied URL. Resolution goes through the injected
 * extractFn (the server wires extractOffer from offer-extract.mjs);
 * without it the candidate is left pending_extraction with NO apply
 * URL invented. Provenance is always "linkedin-import".
 * @param {string} url
 * @param {{extractFn?: ((url: string) => Promise<any>)|null}} opts
 */
export async function importUrl(url, { extractFn = null } = {}) {
  const candidate = {
    id: randomUUID(),
    url,
    title: null,
    company: null,
    location: null,
    applyUrl: null,
    provenance: "linkedin-import",
    importedAt: nowIso(),
    mode: "assisted",
    easyApplyExecuted: false,
    status: "pending_extraction",
    extraction: null,
  };
  if (!extractFn) return candidate;
  const extracted = await extractFn(url);
  candidate.extraction = extracted?.status ?? null;
  if (extracted?.status === "ok") {
    candidate.title = extracted.title;
    candidate.company = extracted.company;
    candidate.description = extracted.description;
    candidate.language = extracted.language;
    candidate.status = "extracted";
  } else {
    candidate.status = extracted?.status ?? "extraction_failed";
  }
  return candidate;
}

/** Parse one CSV line, honouring double-quoted fields with commas. @param {string} line */
function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Import CSV rows with columns title, company, url, location (header
 * names matched case-insensitively, in any order). Rows without a URL
 * are skipped. Provenance is always "linkedin-csv-import".
 * @param {string} csvText
 */
export function importCsv(csvText) {
  const lines = String(csvText ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((name) => name.toLowerCase());
  const hasHeader = header.includes("url") || header.includes("title");
  const urlIdx = header.indexOf("url");
  if (!hasHeader || urlIdx === -1) return [];
  const titleIdx = header.indexOf("title");
  const companyIdx = header.indexOf("company");
  const locationIdx = header.indexOf("location");
  const candidates = [];
  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line);
    const url = fields[urlIdx];
    if (!url) continue;
    candidates.push({
      id: randomUUID(),
      url,
      title: titleIdx === -1 ? null : (fields[titleIdx] || null),
      company: companyIdx === -1 ? null : (fields[companyIdx] || null),
      location: locationIdx === -1 ? null : (fields[locationIdx] || null),
      applyUrl: null,
      provenance: "linkedin-csv-import",
      importedAt: nowIso(),
      mode: "assisted",
      easyApplyExecuted: false,
      status: "pending_extraction",
    });
  }
  return candidates;
}

/**
 * Import pasted text: extract http(s) URLs, deduplicated in order of
 * first appearance. Provenance is always "linkedin-text-import".
 * @param {string} text
 */
export function importText(text) {
  const found = String(text ?? "").match(/https?:\/\/[^\s<>"'`,;]+/g) ?? [];
  const seen = new Set();
  const candidates = [];
  for (const raw of found) {
    const url = raw.replace(/[.)]+$/, "");
    if (!url || seen.has(url)) continue;
    seen.add(url);
    candidates.push({
      id: randomUUID(),
      url,
      title: null,
      company: null,
      location: null,
      applyUrl: null,
      provenance: "linkedin-text-import",
      importedAt: nowIso(),
      mode: "assisted",
      easyApplyExecuted: false,
      status: "pending_extraction",
    });
  }
  return candidates;
}

/**
 * Normalize a URL for matching: drop known tracking parameters and the
 * fragment, and drop a trailing slash. Parameters that can identify a
 * posting, location or form version are KEPT.
 * @param {string} value
 */
export function normalizeUrlForMatch(value) {
  try {
    const parsed = new URL(value);
    for (const param of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "mc_cid", "_ga"]) parsed.searchParams.delete(param);
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return String(value ?? "").trim().toLowerCase();
  }
}

/** Normalize company/title text for weak matching (case, accents, punctuation). @param {string|null} value */
export function normalizeCompanyTitle(value) {
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Resolve an imported candidate against already-known offers.
 *   - certain: a canonical/apply URL matches (after tracking-param
 *     normalization). This is the only certain level.
 *   - uncertain: only normalized company + title match. A weak match
 *     is FLAGGED as uncertain and never asserted as certain: two
 *     distinct vacancies can share a company and a title.
 *   - none: no match.
 * @param {{url?: string|null, canonicalUrl?: string|null, applyUrl?: string|null, title?: string|null, company?: string|null}} candidate
 * @param {Array<{canonicalUrl?: string|null, applyUrl?: string|null, url?: string|null, title?: string|null, company?: string|null}>} knownOffers
 */
export function resolveExternal(candidate, knownOffers = []) {
  const candidateUrls = [candidate.canonicalUrl, candidate.applyUrl, candidate.url].filter(Boolean).map(normalizeUrlForMatch);
  for (const offer of knownOffers) {
    const offerUrls = [offer.canonicalUrl, offer.applyUrl, offer.url].filter(Boolean).map(normalizeUrlForMatch);
    if (candidateUrls.some((url) => offerUrls.includes(url))) {
      return { matched: true, certainty: "certain", offer, reason: "canonical_url" };
    }
  }
  const candidateKey = `${normalizeCompanyTitle(candidate.company)}|${normalizeCompanyTitle(candidate.title)}`;
  if (normalizeCompanyTitle(candidate.company) && normalizeCompanyTitle(candidate.title)) {
    for (const offer of knownOffers) {
      const offerKey = `${normalizeCompanyTitle(offer.company)}|${normalizeCompanyTitle(offer.title)}`;
      if (offerKey === candidateKey) {
        return { matched: true, certainty: "uncertain", offer, reason: "company_title_weak_match" };
      }
    }
  }
  return { matched: false, certainty: "none", offer: null, reason: "no_match" };
}
