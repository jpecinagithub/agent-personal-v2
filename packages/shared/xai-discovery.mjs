// F3 xAI discovery support (T-V2-029, RF-V2-029; design doc 03 section 1).
//
// This module NEVER calls xAI: it holds no API key, makes no request to
// api.x.ai, and performs no generation. The server wires a VERIFIED xAI
// web-search function later; this module only (a) builds search queries
// from search criteria and (b) validates a returned URL against the
// original offer. No opportunity is EVER created from an LLM assertion
// alone: a URL counts only after validateDiscovery confirms it against
// the expected offer, and even then the normal pipeline (extraction,
// language, dedupe) still has to accept it.
//
// Query construction takes TITLES and LOCATIONS only. Any other field
// a caller passes (profile data, CV content, personal documents, names)
// is IGNORED, never interpolated into a query: discovery queries are
// public web searches and must never carry personal data (design doc
// 03 section 5, step 3).
export const MAX_DISCOVERY_QUERIES = 20;

const TITLE_STOPWORDS = new Set(["the", "and", "of", "for", "in", "a", "an", "de", "la", "el", "en", "y"]);

function cleanQueryPart(value) {
  return String(value ?? "").replace(/[""]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Build web-search queries from titles x locations. With no locations,
 * one query per title. Capped at MAX_DISCOVERY_QUERIES. Extra fields
 * on the criteria object are ignored by construction.
 * @param {{titles?: string[], locations?: string[]}} criteria
 * @returns {string[]}
 */
export function generateQueries({ titles = [], locations = [] } = {}) {
  const cleanTitles = titles.map(cleanQueryPart).filter(Boolean);
  const cleanLocations = locations.map(cleanQueryPart).filter(Boolean);
  if (cleanTitles.length === 0) return [];
  const queries = [];
  if (cleanLocations.length === 0) {
    for (const title of cleanTitles) queries.push(`"${title}" jobs careers`);
  } else {
    for (const title of cleanTitles) {
      for (const location of cleanLocations) {
        queries.push(`"${title}" jobs ${location}`);
        if (queries.length >= MAX_DISCOVERY_QUERIES) return queries;
      }
    }
  }
  return queries.slice(0, MAX_DISCOVERY_QUERIES);
}

function stripToText(html) {
  return String(html ?? "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function contentTokens(text) {
  const tokens = String(text ?? "").toLowerCase().match(/[\p{L}0-9]+/gu) ?? [];
  return new Set(tokens.filter((token) => token.length > 2 && !TITLE_STOPWORDS.has(token)));
}

// Generic legal-form suffixes carry no identity: "Corp" alone must not
// match "Example Corp" against an unrelated "Other Corp" page.
const COMPANY_GENERIC_SUFFIXES = new Set(["corp", "corporation", "inc", "llc", "ltd", "limited", "company", "co", "group", "gmbh", "srl", "sa", "ag", "bv", "plc"]);

function companyTokens(text) {
  const tokens = contentTokens(text);
  for (const generic of COMPANY_GENERIC_SUFFIXES) tokens.delete(generic);
  return tokens;
}

/**
 * Heuristic token match: at least half of the expected tokens (and at
 * least one) must appear in the page text. Token sets drop short words
 * and stopwords, so "Finance Manager" matches on finance/manager, not
 * on filler. Company matching additionally drops generic legal-form
 * suffixes (see companyTokens).
 * @param {string} expected
 * @param {Set<string>} pageTokens
 * @param {boolean} isCompany
 */
function tokenMatch(expected, pageTokens, isCompany = false) {
  const expectedTokens = [...(isCompany ? companyTokens(expected) : contentTokens(expected))];
  if (expectedTokens.length === 0) return { match: false, matched: 0, total: 0 };
  const matched = expectedTokens.filter((token) => pageTokens.has(token)).length;
  return { match: matched >= Math.ceil(expectedTokens.length / 2), matched, total: expectedTokens.length };
}

/**
 * Validate a discovered URL against the original offer: fetch it with
 * the injected fetchFn and check, heuristically, that the page carries
 * the expected title and company. The returned `citations` are just
 * the fetched URL itself — real xAI search citations are attached by
 * the server-side xAI wiring, not fabricated here.
 *
 * verified is true ONLY when every expected field that was supplied
 * matches. With no expected title AND no expected company there is
 * nothing to check against, so verified is false: a page is never
 * "verified" against nothing.
 *
 * @param {string} url
 * @param {{fetchFn?: any, expectedTitle?: string|null, expectedCompany?: string|null, expected?: {title?: string|null, company?: string|null}|null, timeoutMs?: number}} opts
 * @returns {Promise<{url: string, citations: string[], verified: boolean, reason: string, titleMatch: boolean, companyMatch: boolean}>}
 */
export async function validateDiscovery(url, { fetchFn = globalThis.fetch, expectedTitle = null, expectedCompany = null, expected = null, timeoutMs = 15000 } = {}) {
  const title = expected?.title ?? expectedTitle;
  const company = expected?.company ?? expectedCompany;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { url, citations: [url], verified: false, reason: "invalid_url", titleMatch: false, companyMatch: false };
  }
  if (parsed.protocol !== "https:") return { url, citations: [url], verified: false, reason: "only_https", titleMatch: false, companyMatch: false };
  if (!title && !company) return { url, citations: [url], verified: false, reason: "nothing_to_check_against", titleMatch: false, companyMatch: false };
  let res;
  try {
    res = await fetchFn(url, {
      method: "GET",
      headers: { Accept: "text/html,application/xhtml+xml" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") return { url, citations: [url], verified: false, reason: "fetch_failed: timeout", titleMatch: false, companyMatch: false };
    return { url, citations: [url], verified: false, reason: `fetch_failed: ${err instanceof Error ? err.message : String(err)}`, titleMatch: false, companyMatch: false };
  }
  if (!res.ok) return { url, citations: [url], verified: false, reason: `http_${res.status}`, titleMatch: false, companyMatch: false };
  let body;
  try {
    body = await res.text();
  } catch (err) {
    return { url, citations: [url], verified: false, reason: `read_failed: ${err instanceof Error ? err.message : String(err)}`, titleMatch: false, companyMatch: false };
  }
  const pageTokens = contentTokens(stripToText(body));
  const titleCheck = title ? tokenMatch(title, pageTokens, false) : { match: true, matched: 0, total: 0 };
  const companyCheck = company ? tokenMatch(company, pageTokens, true) : { match: true, matched: 0, total: 0 };
  const verified = titleCheck.match && companyCheck.match;
  let reason;
  if (verified) reason = "title_and_company_match";
  else if (title && !titleCheck.match && company && !companyCheck.match) reason = "title_and_company_mismatch";
  else if (title && !titleCheck.match) reason = "title_mismatch";
  else reason = "company_mismatch";
  return { url, citations: [url], verified, reason, titleMatch: titleCheck.match, companyMatch: companyCheck.match };
}
