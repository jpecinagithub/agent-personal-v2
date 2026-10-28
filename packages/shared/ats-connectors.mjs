// F3 connectors (T-V2-026 Greenhouse, T-V2-027 Lever, T-V2-028 Ashby;
// RF-V2-030, RF-V2-035; design doc 03-BUSQUEDA-AVANZADA.md section 1).
//
// What these connectors are: thin clients over each ATS's PUBLIC board
// API, for boards already in the company catalog. They are NOT a global
// search of the whole ATS: there is no such public endpoint, and no
// capability here claims one. Only catalog boards are ever consulted.
//
// Capabilities, honestly stated for all three:
//   - list + detail only. No global ATS search, no keyword search.
//   - The public endpoints accept NO title/location filter parameters,
//     so even title/location matching is postprocessing done by the
//     search core, never a native filter. Everything beyond list+detail
//     (seniority, salary, sponsorship, skills, ...) is postprocessed or
//     unknown, never native.
//   - Greenhouse has NO pagination on its board jobs endpoint: one GET
//     returns the whole board. The cursor is therefore always null.
//   - Lever paginates with skip/limit; the cursor is the next skip.
//   - Ashby returns the whole board in one GET; the cursor is null.
//   - The public Lever API exposes NO custom application questions:
//     questions only exist inside the rendered application form (see
//     registers/ats-matrix.md). Nothing here invents or fetches them.
//   - Greenhouse returns updated_at only, never a publication date, so
//     publishedAt is ALWAYS null for Greenhouse; updated_at is stored
//     as evidence.lastObserved, never relabelled as published.
//   - A failed source NEVER returns an empty jobs list presented as
//     success: failures carry status != "ok" plus a cause. The search
//     core must surface that status (RF-V2-028, RF-V2-039), not render
//     it as "zero results found".
//
// Board/API hosts pass the guard in packages/shared/guard.mjs
// (ALLOWED_HOSTS already includes boards-api.greenhouse.io,
// api.lever.co and api.ashbyhq.com); every request is checked with
// assertFetchHost before it is issued. The fetch function is injectable
// (default globalThis.fetch) so tests prove every outcome with mocks
// and no test ever touches the real network.
import { assertFetchHost } from "./guard.mjs";

export const DEFAULT_CONNECTOR_TIMEOUT_MS = 15000;

/**
 * Capability declaration per ATS. `nativeFilters` lists filters the
 * public endpoint itself accepts (none for all three: matching is
 * postprocessed). `nativeFilterCeiling` records the most a caller may
 * ever assume natively: title/location at most, everything else
 * postprocessed or unavailable.
 */
export const ATS_CAPABILITIES = {
  greenhouse: {
    ats: "greenhouse",
    mode: "catalog-board-list-only",
    globalSearch: false,
    list: true,
    detail: true,
    pagination: "none",
    paginationNote: "The Greenhouse boards jobs endpoint has no pagination: one GET returns the whole board.",
    nativeFilters: [],
    nativeFilterCeiling: "title/location at most (postprocessed in practice: the endpoint accepts no filter parameters)",
    customApplicationQuestions: false,
    customApplicationQuestionsNote: "Custom questions are not exposed by the public boards API.",
    publishedDate: false,
    publishedDateNote: "Greenhouse returns updated_at only; publishedAt stays null and updated_at is stored as evidence.lastObserved, never as published.",
  },
  lever: {
    ats: "lever",
    mode: "catalog-board-list-only",
    globalSearch: false,
    list: true,
    detail: true,
    pagination: "skip-limit",
    paginationNote: "skip/limit pagination; the cursor is the next skip value, null on a partial final page.",
    nativeFilters: [],
    nativeFilterCeiling: "title/location at most (postprocessed in practice: the endpoint accepts no filter parameters)",
    customApplicationQuestions: false,
    customApplicationQuestionsNote: "DOCUMENTED ABSENCE: the public Lever postings API exposes NO custom application questions; questions exist only inside the rendered application form and are therefore out of reach of this connector.",
    publishedDate: true,
    publishedDateNote: "Lever reports createdAt (posting creation timestamp); it is mapped to publishedAt with that evidence, not invented.",
  },
  ashby: {
    ats: "ashby",
    mode: "catalog-board-list-only",
    globalSearch: false,
    list: true,
    detail: true,
    pagination: "none",
    paginationNote: "The Ashby job-board endpoint returns the whole board in one GET; there is no pagination cursor.",
    nativeFilters: [],
    nativeFilterCeiling: "title/location at most (postprocessed in practice: the endpoint accepts no filter parameters)",
    customApplicationQuestions: false,
    customApplicationQuestionsNote: "Custom questions are not exposed by the public job-board API.",
    publishedDate: true,
    publishedDateNote: "Ashby reports publishedAt; it is mapped directly with evidence.",
    detailNote: "Ashby's public job-board API offers no separate detail endpoint: the list payload already carries the full description, so detail is resolved by re-fetching the board and selecting the posting id.",
  },
};

/**
 * @typedef {Object} NormalizedOffer
 * @property {string} source
 * @property {string} ats
 * @property {string} tenant
 * @property {string} postingId
 * @property {string|null} canonicalUrl
 * @property {string|null} applyUrl
 * @property {string} title
 * @property {string|null} company
 * @property {{country: string|null, region: string|null, city: string|null, raw: string|null, remote: boolean}} location
 * @property {"remote"|"hybrid"|"onsite"|"unknown"} workMode
 * @property {string|null} seniority
 * @property {string|null} contractType
 * @property {string|null} workingTime
 * @property {string|null} sector
 * @property {string} description
 * @property {string[]} skills
 * @property {{min: number|null, max: number|null, currency: string|null, period: string|null, published: boolean}} salary
 * @property {string|null} language
 * @property {string|null} languageMethod
 * @property {"yes"|"no"|"unknown"} sponsorship
 * @property {"yes"|"no"|"unknown"} relocation
 * @property {string|null} publishedAt
 * @property {string} firstSeenAt
 * @property {Object<string, string>} evidence
 */

/**
 * @typedef {Object} ConnectorResult
 * @property {"ok"|"rate_limited"|"unavailable"|"blocked"|"auth_required"} status
 * @property {number|null} retryAfterMs
 * @property {NormalizedOffer[]} jobs
 * @property {any} cursor
 * @property {Object} evidence
 * @property {string|null} cause
 * @property {{postingId: string, reason: string}[]} excluded
 */

function nowIso() {
  return new Date().toISOString();
}

function stripTags(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function asText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/**
 * Heuristic parse of a free-text location. Only the raw string is
 * source truth; city/region/country are positional guesses ("City,
 * Region, Country" / "City, Country") and stay null when the shape
 * does not support them. Nothing is invented: an unparseable location
 * keeps its raw text and null parts, and workMode is "unknown" unless
 * the raw text itself says remote/hybrid.
 * @param {string|null} raw
 */
export function parseLocation(raw) {
  const rawText = asText(raw);
  if (!rawText) return { country: null, region: null, city: null, raw: null, remote: false };
  const remote = /remote/i.test(rawText);
  const parts = rawText.split(",").map((p) => p.trim()).filter(Boolean);
  if (remote && parts.length === 1) return { country: null, region: null, city: null, raw: rawText, remote: true };
  if (parts.length >= 3) return { country: parts[parts.length - 1], region: parts.slice(1, -1).join(", "), city: parts[0], raw: rawText, remote };
  if (parts.length === 2) return { country: parts[1], region: null, city: parts[0], raw: rawText, remote };
  return { country: null, region: null, city: parts[0], raw: rawText, remote };
}

/** @param {string|null} raw */
export function workModeFromLocation(raw) {
  if (!raw) return "unknown";
  if (/remote/i.test(raw)) return "remote";
  if (/hybrid/i.test(raw)) return "hybrid";
  return "unknown";
}

/** @param {Partial<NormalizedOffer>} partial */
function baseOffer(partial) {
  return {
    source: partial.source ?? "unknown",
    ats: partial.ats ?? "unknown",
    tenant: partial.tenant ?? "unknown",
    postingId: partial.postingId ?? "unknown",
    canonicalUrl: partial.canonicalUrl ?? null,
    applyUrl: partial.applyUrl ?? null,
    title: partial.title ?? "unknown",
    company: partial.company ?? null,
    location: partial.location ?? { country: null, region: null, city: null, raw: null, remote: false },
    workMode: partial.workMode ?? "unknown",
    seniority: partial.seniority ?? null,
    contractType: partial.contractType ?? null,
    workingTime: partial.workingTime ?? null,
    sector: partial.sector ?? null,
    description: partial.description ?? "",
    skills: partial.skills ?? [],
    salary: partial.salary ?? { min: null, max: null, currency: null, period: null, published: false },
    language: partial.language ?? null,
    languageMethod: partial.languageMethod ?? null,
    sponsorship: partial.sponsorship ?? "unknown",
    relocation: partial.relocation ?? "unknown",
    publishedAt: partial.publishedAt ?? null,
    firstSeenAt: nowIso(),
    evidence: partial.evidence ?? {},
  };
}

function parseRetryAfter(res) {
  try {
    const raw = res.headers?.get?.("retry-after");
    if (raw === null || raw === undefined) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
    const dateMs = Date.parse(String(raw));
    if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
    return null;
  } catch {
    return null;
  }
}

/**
 * One guarded JSON call. Never throws for HTTP outcomes: every failure
 * is a typed result with a cause, so a caller can never mistake it for
 * an empty-but-successful board.
 * @param {string} url
 * @param {{fetchFn?: any, timeoutMs?: number}} opts
 * @returns {Promise<{status: "ok"|"rate_limited"|"unavailable"|"blocked"|"auth_required", retryAfterMs: number|null, body: any, cause: string|null}>}
 */
async function callApi(url, { fetchFn = globalThis.fetch, timeoutMs = DEFAULT_CONNECTOR_TIMEOUT_MS } = {}) {
  assertFetchHost(url);
  let res;
  try {
    res = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") return { status: "unavailable", retryAfterMs: null, body: null, cause: "timeout" };
    return { status: "unavailable", retryAfterMs: null, body: null, cause: `network: ${err instanceof Error ? err.message : String(err)}` };
  }
  const retryAfterMs = parseRetryAfter(res);
  if (res.status === 429) return { status: "rate_limited", retryAfterMs, body: null, cause: "http_429" };
  if (res.status === 401) return { status: "auth_required", retryAfterMs, body: null, cause: "http_401" };
  if (res.status === 403) return { status: "blocked", retryAfterMs, body: null, cause: "http_403" };
  if (!res.ok) return { status: "unavailable", retryAfterMs, body: null, cause: `http_${res.status}` };
  let body;
  try {
    body = await res.json();
  } catch {
    return { status: "unavailable", retryAfterMs, body: null, cause: "invalid_response" };
  }
  return { status: "ok", retryAfterMs, body, cause: null };
}

/**
 * @param {"ok"|"rate_limited"|"unavailable"|"blocked"|"auth_required"} status
 * @param {any} extra
 * @returns {ConnectorResult}
 */
function failureResult(status, extra = {}) {
  return {
    status,
    retryAfterMs: extra.retryAfterMs ?? null,
    jobs: [],
    cursor: null,
    evidence: extra.evidence ?? {},
    cause: extra.cause ?? null,
    excluded: [],
  };
}

// ---------------------------------------------------------------------------
// Greenhouse (T-V2-026)
// ---------------------------------------------------------------------------

export function greenhouseListUrl(boardToken) {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs`;
}

export function greenhouseDetailUrl(boardToken, jobId) {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(jobId)}`;
}

/**
 * Normalize one Greenhouse job. Missing text fields become "unknown"
 * (title) or null (company/location parts), never invented values.
 * publishedAt is ALWAYS null: Greenhouse returns updated_at only.
 * @param {any} job
 * @param {{board: string, company?: string|null}} ctx
 */
export function normalizeGreenhouseJob(job, { board, company = null } = /** @type {any} */ ({})) {
  const locationRaw = job?.location?.name ?? (typeof job?.location === "string" ? job.location : null);
  const absoluteUrl = asText(job?.absolute_url);
  return baseOffer({
    source: "greenhouse",
    ats: "greenhouse",
    tenant: board,
    postingId: String(job?.id ?? "unknown"),
    canonicalUrl: absoluteUrl,
    applyUrl: absoluteUrl,
    title: asText(job?.title) ?? "unknown",
    company: asText(job?.company_name) ?? company ?? null,
    location: parseLocation(locationRaw),
    workMode: workModeFromLocation(locationRaw),
    description: stripTags(job?.content ?? ""),
    publishedAt: null,
    evidence: {
      title: "greenhouse:list.title",
      company: "greenhouse:board",
      location: "greenhouse:list.location.name",
      canonicalUrl: "greenhouse:list.absolute_url",
      applyUrl: "greenhouse:list.absolute_url",
      description: "greenhouse:list.content",
      publishedAt: "not provided by Greenhouse: updated_at only, never relabelled as published",
      lastObserved: job?.updated_at ? `greenhouse:list.updated_at=${job.updated_at}` : "greenhouse:list.updated_at missing",
    },
  });
}

/**
 * List a Greenhouse board. No pagination exists on this endpoint:
 * cursor is always null and every job on the board is returned.
 * @param {string} boardToken
 * @param {{fetchFn?: any, timeoutMs?: number, company?: string|null}} opts
 * @returns {Promise<ConnectorResult>}
 */
export async function fetchGreenhouseJobs(boardToken, { fetchFn = globalThis.fetch, timeoutMs = DEFAULT_CONNECTOR_TIMEOUT_MS, company = null } = {}) {
  const url = greenhouseListUrl(boardToken);
  const call = await callApi(url, { fetchFn, timeoutMs });
  if (call.status !== "ok") return failureResult(call.status, { retryAfterMs: call.retryAfterMs, cause: call.cause, evidence: { source: "greenhouse", endpoint: url } });
  const rawJobs = Array.isArray(call.body) ? call.body : Array.isArray(call.body?.jobs) ? call.body.jobs : null;
  if (rawJobs === null) return failureResult("unavailable", { retryAfterMs: call.retryAfterMs, cause: "invalid_response: expected jobs array", evidence: { source: "greenhouse", endpoint: url } });
  return {
    status: "ok",
    retryAfterMs: call.retryAfterMs,
    jobs: rawJobs.map((job) => normalizeGreenhouseJob(job, { board: boardToken, company })),
    cursor: null,
    evidence: { source: "greenhouse", endpoint: url, pagination: "none: Greenhouse board endpoint has no pagination" },
    cause: null,
    excluded: [],
  };
}

/**
 * Detail for one Greenhouse posting.
 * @param {string} boardToken
 * @param {string|number} jobId
 * @param {{fetchFn?: any, timeoutMs?: number, company?: string|null}} opts
 * @returns {Promise<ConnectorResult>}
 */
export async function fetchGreenhouseJob(boardToken, jobId, { fetchFn = globalThis.fetch, timeoutMs = DEFAULT_CONNECTOR_TIMEOUT_MS, company = null } = {}) {
  const url = greenhouseDetailUrl(boardToken, jobId);
  const call = await callApi(url, { fetchFn, timeoutMs });
  if (call.status !== "ok") return failureResult(call.status, { retryAfterMs: call.retryAfterMs, cause: call.cause, evidence: { source: "greenhouse", endpoint: url } });
  const job = call.body && typeof call.body === "object" ? call.body : null;
  if (!job) return failureResult("unavailable", { retryAfterMs: call.retryAfterMs, cause: "invalid_response: expected job object", evidence: { source: "greenhouse", endpoint: url } });
  return {
    status: "ok",
    retryAfterMs: call.retryAfterMs,
    jobs: [normalizeGreenhouseJob(job, { board: boardToken, company })],
    cursor: null,
    evidence: { source: "greenhouse", endpoint: url },
    cause: null,
    excluded: [],
  };
}

// ---------------------------------------------------------------------------
// Lever (T-V2-027)
// ---------------------------------------------------------------------------

export function leverListUrl(site, { skip = 0, limit = 50 } = {}) {
  return `https://api.lever.co/v0/postings/${encodeURIComponent(site)}?skip=${skip}&limit=${limit}&mode=json`;
}

/**
 * Normalize one Lever posting defensively: missing text fields become
 * "unknown"/null, never invented. Lever createdAt (posting creation
 * timestamp) is mapped to publishedAt with that evidence.
 * @param {any} posting
 * @param {{site: string, company?: string|null}} ctx
 */
export function normalizeLeverPosting(posting, { site, company = null } = /** @type {any} */ ({})) {
  const locationRaw = posting?.categories?.location ?? (typeof posting?.location === "string" ? posting.location : null);
  const applyUrl = asText(posting?.applyUrl) ?? asText(posting?.hostedUrl);
  const canonicalUrl = asText(posting?.hostedUrl) ?? applyUrl;
  let publishedAt = null;
  const createdAt = posting?.createdAt;
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) publishedAt = new Date(createdAt).toISOString();
  else if (typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt))) publishedAt = new Date(createdAt).toISOString();
  return baseOffer({
    source: "lever",
    ats: "lever",
    tenant: site,
    postingId: String(posting?.id ?? "unknown"),
    canonicalUrl,
    applyUrl,
    title: asText(posting?.text) ?? "unknown",
    company: company ?? null,
    location: parseLocation(locationRaw),
    workMode: workModeFromLocation(locationRaw),
    contractType: asText(posting?.categories?.commitment),
    sector: asText(posting?.categories?.team),
    description: stripTags(posting?.descriptionPlain ?? posting?.description ?? ""),
    publishedAt,
    evidence: {
      title: "lever:list.text",
      company: "lever:site (the public API exposes no company_name equivalent; the board slug identifies the company)",
      location: "lever:list.categories.location",
      canonicalUrl: "lever:list.hostedUrl",
      applyUrl: "lever:list.applyUrl or hostedUrl",
      description: "lever:list.descriptionPlain or description",
      publishedAt: createdAt !== undefined && createdAt !== null ? "lever:list.createdAt" : "not provided by Lever for this posting",
    },
  });
}

/**
 * List a Lever site with skip/limit pagination. The cursor is the next
 * skip value when a full page was returned, else null (final page).
 * @param {string} site
 * @param {{fetchFn?: any, timeoutMs?: number, skip?: number, limit?: number, company?: string|null}} opts
 * @returns {Promise<ConnectorResult>}
 */
export async function fetchLeverPostings(site, { fetchFn = globalThis.fetch, timeoutMs = DEFAULT_CONNECTOR_TIMEOUT_MS, skip = 0, limit = 50, company = null } = {}) {
  const url = leverListUrl(site, { skip, limit });
  const call = await callApi(url, { fetchFn, timeoutMs });
  if (call.status !== "ok") return failureResult(call.status, { retryAfterMs: call.retryAfterMs, cause: call.cause, evidence: { source: "lever", endpoint: url } });
  const rawJobs = Array.isArray(call.body) ? call.body : null;
  if (rawJobs === null) return failureResult("unavailable", { retryAfterMs: call.retryAfterMs, cause: "invalid_response: expected postings array", evidence: { source: "lever", endpoint: url } });
  const jobs = rawJobs.map((posting) => normalizeLeverPosting(posting, { site, company }));
  return {
    status: "ok",
    retryAfterMs: call.retryAfterMs,
    jobs,
    cursor: jobs.length === limit ? { skip: skip + limit, limit } : null,
    evidence: { source: "lever", endpoint: url, pagination: "skip/limit" },
    cause: null,
    excluded: [],
  };
}

/**
 * Detail for one Lever posting: the public API has no single-posting
 * endpoint, so detail is resolved by listing the site and selecting
 * the posting id (the list payload already carries the full text).
 * @param {string} site
 * @param {string} postingId
 * @param {{fetchFn?: any, timeoutMs?: number, company?: string|null}} opts
 * @returns {Promise<ConnectorResult>}
 */
export async function fetchLeverPosting(site, postingId, { fetchFn = globalThis.fetch, timeoutMs = DEFAULT_CONNECTOR_TIMEOUT_MS, company = null } = {}) {
  const list = await fetchLeverPostings(site, { fetchFn, timeoutMs, skip: 0, limit: 100, company });
  if (list.status !== "ok") return list;
  const found = list.jobs.find((job) => job.postingId === String(postingId));
  if (!found) return failureResult("unavailable", { cause: "posting_not_found_on_site", evidence: { source: "lever", site } });
  return { ...list, jobs: [found] };
}

// ---------------------------------------------------------------------------
// Ashby (T-V2-028)
// ---------------------------------------------------------------------------

export function ashbyListUrl(board) {
  return `https://api.ashbyhq.com/job-board-api/job-board/${encodeURIComponent(board)}`;
}

/**
 * Normalize one Ashby posting. isListed === false entries are NOT
 * normalized here: fetchAshbyJobs excludes them with an explicit
 * recorded reason instead (source contract, 03 section 1).
 * @param {any} job
 * @param {{board: string, company?: string|null}} ctx
 */
export function normalizeAshbyJob(job, { board, company = null } = /** @type {any} */ ({})) {
  const locationRaw = job?.locationName ?? job?.location ?? (typeof job?.location === "object" ? job.location?.name : null) ?? null;
  const jobUrl = asText(job?.jobUrl) ?? asText(job?.url) ?? asText(job?.applyUrl);
  let publishedAt = null;
  if (typeof job?.publishedAt === "string" && !Number.isNaN(Date.parse(job.publishedAt))) publishedAt = job.publishedAt;
  return baseOffer({
    source: "ashby",
    ats: "ashby",
    tenant: board,
    postingId: String(job?.id ?? "unknown"),
    canonicalUrl: jobUrl,
    applyUrl: jobUrl,
    title: asText(job?.title) ?? "unknown",
    company: company ?? null,
    location: parseLocation(locationRaw),
    workMode: workModeFromLocation(locationRaw),
    sector: asText(job?.departmentName) ?? asText(job?.department),
    description: stripTags(job?.descriptionHtml ?? job?.description ?? ""),
    publishedAt,
    evidence: {
      title: "ashby:list.title",
      company: "ashby:board (the public API exposes no company_name equivalent; the board slug identifies the company)",
      location: "ashby:list.locationName",
      canonicalUrl: "ashby:list.jobUrl",
      applyUrl: "ashby:list.jobUrl",
      description: "ashby:list.descriptionHtml",
      publishedAt: job?.publishedAt ? "ashby:list.publishedAt" : "not provided by Ashby for this posting",
    },
  });
}

/**
 * List an Ashby board. Entries with isListed === false are EXCLUDED
 * per the source contract and recorded in `excluded` with reason
 * "not_listed" — never silently dropped, never presented as jobs.
 * No pagination exists on this endpoint: cursor is always null.
 * @param {string} board
 * @param {{fetchFn?: any, timeoutMs?: number, company?: string|null}} opts
 * @returns {Promise<ConnectorResult>}
 */
export async function fetchAshbyJobs(board, { fetchFn = globalThis.fetch, timeoutMs = DEFAULT_CONNECTOR_TIMEOUT_MS, company = null } = {}) {
  const url = ashbyListUrl(board);
  const call = await callApi(url, { fetchFn, timeoutMs });
  if (call.status !== "ok") return failureResult(call.status, { retryAfterMs: call.retryAfterMs, cause: call.cause, evidence: { source: "ashby", endpoint: url } });
  const rawJobs = Array.isArray(call.body) ? call.body : Array.isArray(call.body?.jobs) ? call.body.jobs : null;
  if (rawJobs === null) return failureResult("unavailable", { retryAfterMs: call.retryAfterMs, cause: "invalid_response: expected jobs array", evidence: { source: "ashby", endpoint: url } });
  const jobs = [];
  const excluded = [];
  for (const job of rawJobs) {
    if (job?.isListed === false) {
      excluded.push({ postingId: String(job?.id ?? "unknown"), reason: "not_listed" });
      continue;
    }
    jobs.push(normalizeAshbyJob(job, { board, company }));
  }
  return {
    status: "ok",
    retryAfterMs: call.retryAfterMs,
    jobs,
    cursor: null,
    evidence: { source: "ashby", endpoint: url, pagination: "none: Ashby job-board endpoint has no pagination" },
    cause: null,
    excluded,
  };
}

/**
 * Detail for one Ashby posting: no separate detail endpoint is offered
 * by the public job-board API, so detail is resolved by re-fetching
 * the board and selecting the posting id (the list payload already
 * carries the full description).
 * @param {string} board
 * @param {string} jobId
 * @param {{fetchFn?: any, timeoutMs?: number, company?: string|null}} opts
 * @returns {Promise<ConnectorResult>}
 */
export async function fetchAshbyJob(board, jobId, { fetchFn = globalThis.fetch, timeoutMs = DEFAULT_CONNECTOR_TIMEOUT_MS, company = null } = {}) {
  const list = await fetchAshbyJobs(board, { fetchFn, timeoutMs, company });
  if (list.status !== "ok") return list;
  const found = list.jobs.find((job) => job.postingId === String(jobId));
  if (!found) {
    const wasExcluded = list.excluded.find((entry) => entry.postingId === String(jobId));
    if (wasExcluded) return failureResult("unavailable", { cause: "posting_not_listed", evidence: { source: "ashby", board } });
    return failureResult("unavailable", { cause: "posting_not_found_on_board", evidence: { source: "ashby", board } });
  }
  return { ...list, jobs: [found], excluded: [] };
}
