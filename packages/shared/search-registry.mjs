// Pliego F3 T-V2-025 (RF-V2-028, RF-V2-096, RF-V2-030, RF-V2-032):
// the connector registry and per-capability criteria compilation.
//
// Honesty rules (03 §1–§2, RF-V2-028):
// - A source publishes what it can do natively, what is checked
//   after retrieval (postprocessed), and what it cannot do at all
//   (unsupported). The UI shows exactly that split.
// - ATS catalogs list a known board's jobs (title/location listing
//   native); everything else is postprocessed. No connector claims a
//   global search of a whole ATS without a catalog behind it:
//   `globalSearch` is `unsupported` for all three ATS catalogs.
// - A source failure is { status: failed|rate_limited|blocked|
//   unavailable, cause } — NEVER zero results (G3: failures are not
//   disguised as "no offers found").
// - Pausing one connector never affects the others (RF-V2-096);
//   status is per-connector state, not a global switch.

const CRITERIA_KEYS = [
  "title", "location", "workMode", "remoteCountries", "seniority",
  "contractType", "workingTime", "sector", "company", "skills",
  "salary", "language", "sponsorship", "relocation", "publishedWithin",
  "descriptionTerms", "authorisation", "globalSearch",
];

// Map from a search-criteria key to the capability key it needs.
const CRITERION_TO_CAPABILITY = {
  titles: "title",
  title: "title",
  countries: "location",
  regions: "location",
  cities: "location",
  location: "location",
  workModes: "workMode",
  workMode: "workMode",
  remoteCountries: "remoteCountries",
  seniority: "seniority",
  contractTypes: "contractType",
  contractType: "contractType",
  workingTime: "workingTime",
  sectors: "sector",
  sector: "sector",
  companies: "company",
  company: "company",
  skills: "skills",
  requiredSkills: "skills",
  excludedSkills: "skills",
  salary: "salary",
  language: "language",
  sponsorship: "sponsorship",
  relocation: "relocation",
  publishedWithinDays: "publishedWithin",
  publishedWithin: "publishedWithin",
  descriptionRequired: "descriptionTerms",
  descriptionExcluded: "descriptionTerms",
  descriptionTerms: "descriptionTerms",
  authorisation: "authorisation",
  globalSearch: "globalSearch",
};

function atsCapabilities() {
  // Title/location listing native; everything else postprocessed on
  // the retrieved listing/detail. Authorisation is profile-side and
  // is never a source capability; global search is unsupported
  // without a catalog covering the whole ATS.
  return {
    title: "native", location: "native",
    workMode: "postprocessed", remoteCountries: "postprocessed",
    seniority: "postprocessed", contractType: "postprocessed",
    workingTime: "postprocessed", sector: "postprocessed",
    company: "postprocessed", skills: "postprocessed",
    salary: "postprocessed", language: "postprocessed",
    sponsorship: "postprocessed", relocation: "postprocessed",
    publishedWithin: "postprocessed", descriptionTerms: "postprocessed",
    authorisation: "unsupported", globalSearch: "unsupported",
  };
}

const DEFAULT_CONNECTORS = [
  {
    id: "greenhouse-catalog", name: "Greenhouse (catalog)", ats: "greenhouse",
    mode: "auto", capabilities: atsCapabilities(),
    pagination: "board listing, page-based where offered; cursor resumed per board",
    limits: "per-board listing limits as documented by the board; no global search",
    status: "active", lastTestedAt: null, degradeReason: null,
  },
  {
    id: "lever-catalog", name: "Lever (catalog)", ats: "lever",
    mode: "auto", capabilities: atsCapabilities(),
    pagination: "site postings, paginated; cursor resumed per site",
    limits: "per-site listing limits; no global search across all Lever",
    status: "active", lastTestedAt: null, degradeReason: null,
  },
  {
    id: "ashby-catalog", name: "Ashby (catalog)", ats: "ashby",
    mode: "auto", capabilities: atsCapabilities(),
    pagination: "job-board listing, paginated; unlisted entries excluded per source contract",
    limits: "per-board listing limits; no global search across all Ashby",
    status: "active", lastTestedAt: null, degradeReason: null,
  },
  {
    id: "xai-web", name: "xAI web discovery", ats: null,
    mode: "auto",
    capabilities: {
      title: "native", descriptionTerms: "native", location: "postprocessed",
      workMode: "postprocessed", remoteCountries: "postprocessed",
      seniority: "postprocessed", contractType: "postprocessed",
      workingTime: "postprocessed", sector: "postprocessed",
      company: "postprocessed", skills: "postprocessed",
      salary: "postprocessed", language: "postprocessed",
      sponsorship: "postprocessed", relocation: "postprocessed",
      publishedWithin: "postprocessed", authorisation: "unsupported",
      globalSearch: "postprocessed",
    },
    pagination: "query rounds bounded by the run budget; each URL verified independently",
    limits: "per-run query/cost budget; indexed results only, never exhaustive",
    status: "active", lastTestedAt: null, degradeReason: null,
  },
  {
    id: "linkedin-assisted", name: "LinkedIn (assisted)", ats: null,
    mode: "assisted",
    capabilities: {
      title: "native", location: "native", company: "native",
      workMode: "postprocessed", remoteCountries: "postprocessed",
      seniority: "postprocessed", contractType: "postprocessed",
      workingTime: "postprocessed", sector: "postprocessed",
      skills: "postprocessed", salary: "postprocessed",
      language: "postprocessed", sponsorship: "postprocessed",
      relocation: "postprocessed", publishedWithin: "postprocessed",
      descriptionTerms: "postprocessed", authorisation: "unsupported",
      globalSearch: "native",
    },
    pagination: "user-driven search pages; imported links/alerts, not automated account access",
    limits: "assisted only — Easy Apply is never executed silently",
    status: "active", lastTestedAt: null, degradeReason: null,
  },
  {
    id: "manual-import", name: "Manual import (URLs / CSV / text)", ats: null,
    mode: "assisted",
    capabilities: Object.fromEntries(CRITERIA_KEYS.map((k) => [k, k === "authorisation" || k === "globalSearch" ? "unsupported" : "postprocessed"])),
    pagination: "none — one imported batch at a time",
    limits: "batch size bounded by the run budget; provenance preserved per item",
    status: "active", lastTestedAt: null, degradeReason: null,
  },
];

// Mutable per-process registry state. Seeded from the defaults above;
// pause/status changes touch only the named connector.
const state = new Map(DEFAULT_CONNECTORS.map((c) => [c.id, JSON.parse(JSON.stringify(c))]));

function copy(connector) {
  return JSON.parse(JSON.stringify(connector));
}

/** All registered connectors (copies; mutating a result changes nothing). */
export function listConnectors() {
  return [...state.values()].map(copy);
}

/** One connector by id, or null when unknown. */
export function getConnector(id) {
  const found = state.get(id);
  return found ? copy(found) : null;
}

const STATUSES = new Set(["active", "paused", "blocked", "degraded"]);

/**
 * Set a connector's status. Returns the updated copy.
 * @param {string} id
 * @param {string} status
 * @param {string | null} [reason]
 */
export function setConnectorStatus(id, status, reason = null) {
  if (!STATUSES.has(status)) throw new Error(`unknown connector status: ${status}`);
  const found = state.get(id);
  if (!found) throw new Error(`unknown connector: ${id}`);
  found.status = status;
  found.degradeReason = status === "active" ? null : (reason ?? found.degradeReason);
  return copy(found);
}

/** Pause one connector; every other connector keeps its own status. */
export function pauseConnector(id, reason = null) {
  return setConnectorStatus(id, "paused", reason);
}

/** Resume a paused connector. */
export function resumeConnector(id) {
  return setConnectorStatus(id, "active", null);
}

/**
 * Compile search criteria for one connector, splitting them into
 * what the source can answer natively, what must be checked after
 * retrieval, and what it cannot do at all. `connector` may be an id
 * or a connector object.
 * @param {any} criteria
 * @param {string | any} connector
 * @returns {{connectorId: string, nativeQuery: any, postprocessed: string[], unsupported: string[]}}
 */
export function compileCriteria(criteria, connector) {
  const resolved = typeof connector === "string" ? getConnector(connector) : connector;
  if (!resolved) throw new Error(`unknown connector: ${connector}`);
  const capabilities = resolved.capabilities ?? {};
  const nativeQuery = {};
  const postprocessed = [];
  const unsupported = [];
  for (const key of Object.keys(criteria ?? {})) {
    const capabilityKey = CRITERION_TO_CAPABILITY[key];
    if (!capabilityKey) { unsupported.push(key); continue; }
    const level = capabilities[capabilityKey];
    if (level === "native") nativeQuery[key] = criteria[key];
    else if (level === "postprocessed") postprocessed.push(key);
    else unsupported.push(key);
  }
  return { connectorId: resolved.id, nativeQuery, postprocessed, unsupported };
}

const FAILURE_STATUSES = new Set(["failed", "rate_limited", "blocked", "unavailable"]);

/**
 * Represent a source failure. This is a failure record, never a
 * zero-result success: callers must not render it as "0 offers".
 * @param {string} status
 * @param {string} cause
 * @returns {{status: string, cause: string}}
 */
export function sourceFailure(status, cause) {
  if (!FAILURE_STATUSES.has(status)) throw new Error(`unknown source failure status: ${status}`);
  if (typeof cause !== "string" || !cause.trim()) throw new Error("source failure cause is required");
  return { status, cause: cause.trim() };
}

/** True when the value is a source-failure record (not a result set). */
export function isSourceFailure(value) {
  return !!value && typeof value === "object" && FAILURE_STATUSES.has(value.status) && typeof value.cause === "string";
}
