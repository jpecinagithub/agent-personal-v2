// F3 full-content extraction (T-V2-031, RF-V2-027, RF-V2-035, RF-V2-037;
// design doc 03 sections 5-6 and 8).
//
// FETCH BOUNDARY — read this before wiring a caller: extraction fetches
// the EXACT user/offer URL passed in and follows its redirects, nothing
// else. This is the T-V2-031 extraction path and is deliberately
// DISTINCT from the board-API path guarded by ALLOWED_HOSTS in
// packages/shared/guard.mjs: offer pages live on arbitrary company
// domains, so they cannot pass that allow-list, and no allow-list
// check is applied here. In exchange this path sends NO credentials,
// NO cookies, NO personal documents and NO profile data — a plain
// unauthenticated GET of a public page. Anything requiring login is
// reported as blocked/unavailable, never worked around.
//
// Honesty rules enforced here:
//   - Dates are kept separate: publishedAt is set ONLY when the page
//     actually publishes one (JSON-LD datePosted); otherwise it is
//     null, never inferred from updatedAt, firstSeenAt or lastCheckedAt.
//   - 403/timeout/network failure is {status: "blocked"|"unavailable"},
//     NEVER "closed". A disappearance from a listing, or a failed fetch,
//     does not prove a vacancy closed (RF-V2-037).
//   - A generic page or a page with too little content is
//     {status: "insufficient"}, not a fabricated offer.
//   - Language is detected from the offer BODY (description/requirements),
//     never from the title: an English-titled offer written in Spanish
//     is Spanish, and a Spanish-titled offer written in English is
//     English (RF-V2-027). Short or mixed text goes to xAI-assisted
//     classification ONLY when the caller injects classifyFn; without
//     it the language is "unknown" and the offer is flagged for review.
//     This module never calls xAI itself: classifyFn is wired by the
//     server from a verified xAI function.
export const DEFAULT_EXTRACT_TIMEOUT_MS = 15000;
export const DEFAULT_EXTRACT_MAX_BYTES = 2000000;
export const MAX_REDIRECTS = 5;
export const MIN_BODY_CHARS = 200;

// Distinctive function words only — no content words like "job" or
// "finance", which would bias detection toward English job-board boilerplate.
const STOPWORDS = {
  en: ["the", "and", "of", "to", "in", "is", "you", "that", "it", "for", "with", "are", "as", "be", "this", "we", "will", "your", "from", "have", "not", "but", "they", "our", "all", "can", "who", "what", "when", "more", "about", "than", "its", "an", "by", "on", "at", "or", "if", "do", "so", "no", "should", "would", "there", "their", "them", "then", "also", "into", "such", "over", "after", "before", "between", "through", "during", "each", "these", "those", "being", "must", "may", "might", "could", "has", "had", "were", "been", "are"],
  es: ["el", "la", "los", "las", "de", "en", "y", "que", "con", "para", "por", "un", "una", "su", "sus", "es", "son", "del", "al", "se", "no", "como", "más", "pero", "sus", "este", "esta", "estos", "estas", "cuando", "donde", "porque", "entre", "sobre", "también", "hasta", "desde", "durante", "contra", "hacia", "según", "sin", "bajo", "tras", "ante", "cada", "otro", "otra", "otros", "otras", "ser", "estar", "haber", "tener", "puede", "debe", "han", "son", "fue", "eran"],
  de: ["der", "die", "das", "und", "ist", "von", "zu", "mit", "für", "den", "dem", "ein", "eine", "im", "am", "wir", "sie", "nicht", "es", "ich", "du", "er", "als", "auch", "sich", "an", "nach", "bei", "aus", "zum", "zur", "haben", "sind", "war", "waren", "wird", "werden", "kann", "können", "soll", "sollen", "muss", "müssen", "durch", "über", "unter", "vor", "nach", "zwischen", "ohne", "gegen", "bis", "seit", "während", "wenn", "dass", "weil", "aber", "oder", "noch", "schon", "sehr", "viel", "mehr"],
  fr: ["le", "la", "les", "de", "des", "et", "est", "dans", "pour", "que", "qui", "une", "un", "du", "au", "aux", "nous", "vous", "sur", "pas", "plus", "ce", "cet", "cette", "ces", "il", "elle", "ils", "elles", "en", "y", "à", "au", "aux", "avec", "sans", "par", "chez", "entre", "comme", "mais", "ou", "donc", "car", "ni", "si", "quand", "où", "comment", "pourquoi", "être", "avoir", "peut", "doit", "sont", "était", "été", "faire", "vous", "nous", "leur", "leurs", "son", "sa", "ses", "mon", "ma", "mes", "ton", "ta"],
};

const SUPPORTED_LANGUAGES = Object.keys(STOPWORDS);

/**
 * Local stopword-ratio language detection. Returns the best language,
 * its share of all stopword hits, and the raw hit counts. A language
 * with zero hits is never asserted.
 * @param {string} text
 * @returns {{language: string, confidence: number, hits: number, scores: Record<string, number>}}
 */
export function detectLanguage(text) {
  const tokens = String(text ?? "").toLowerCase().match(/[\p{L}]+/gu) ?? [];
  const scores = {};
  let total = 0;
  for (const lang of SUPPORTED_LANGUAGES) {
    const set = new Set(STOPWORDS[lang]);
    let hits = 0;
    for (const token of tokens) if (set.has(token)) hits += 1;
    scores[lang] = hits;
    total += hits;
  }
  if (total === 0) return { language: "unknown", confidence: 0, hits: 0, scores };
  let best = "unknown";
  let bestHits = 0;
  for (const lang of SUPPORTED_LANGUAGES) {
    if (scores[lang] > bestHits) {
      best = lang;
      bestHits = scores[lang];
    }
  }
  return { language: best, confidence: bestHits / total, hits: bestHits, scores };
}

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_m, code) => {
      try {
        return String.fromCodePoint(Number(code));
      } catch {
        return "";
      }
    });
}

function stripTagsToText(html) {
  return decodeEntities(String(html ?? "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/**
 * Heuristic main-text extraction: drop scripts/styles/nav/footer/aside,
 * drop cookie/consent/banner/popup blocks by class/id keyword, drop the
 * <h1> title block (the title is a separate field and must not bias
 * language detection), then strip tags. Menus, cookie banners and
 * footers are chrome, not offer content (design doc 03 section 6).
 * @param {string} html
 */
export function extractMainText(html) {
  let working = String(html ?? "");
  const main = working.match(/<(main|article)[^>]*>([\s\S]*?)<\/(main|article)>/i);
  if (main) working = main[2];
  working = working.replace(/<!--[\s\S]*?-->/g, " ");
  working = working.replace(/<(script|style|noscript|template)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  working = working.replace(/<(nav|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  working = working.replace(/<([a-z][a-z0-9]*)[^>]*\b(?:class|id)=["'][^"']*(cookie|consent|banner|newsletter|popup|modal|gdpr|subscribe)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, " ");
  working = working.replace(/<h1[^>]*>[\s\S]*?<\/h1>/gi, " ");
  return stripTagsToText(working);
}

/**
 * Extract a JSON-LD JobPosting block when present. Returns null when
 * there is none (the caller then falls back to main text).
 * @param {string} html
 */
export function extractJsonLdJobPosting(html) {
  const blocks = String(html ?? "").matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const candidates = [];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1].trim());
      const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.["@graph"]) ? parsed["@graph"] : [parsed];
      for (const item of items) {
        const types = Array.isArray(item?.["@type"]) ? item["@type"] : [item?.["@type"]];
        if (types.includes("JobPosting")) candidates.push(item);
      }
    } catch {
      // Malformed JSON-LD is ignored: it is evidence of nothing.
    }
  }
  if (candidates.length === 0) return null;
  const job = candidates[0];
  const org = job.hiringOrganization;
  const company = typeof org === "string" ? org : (org?.name ?? null);
  const loc = job.jobLocation;
  let locationRaw = null;
  if (typeof loc === "string") locationRaw = loc;
  else if (loc?.name) locationRaw = loc.name;
  else if (loc?.address) {
    const address = loc.address;
    locationRaw = typeof address === "string" ? address : [address.addressLocality, address.addressRegion, address.addressCountry].filter(Boolean).join(", ") || null;
  }
  const datePosted = typeof job.datePosted === "string" && !Number.isNaN(Date.parse(job.datePosted)) ? job.datePosted : null;
  const dateModified = typeof job.dateModified === "string" && !Number.isNaN(Date.parse(job.dateModified)) ? job.dateModified : null;
  return {
    title: typeof job.title === "string" && job.title.trim() !== "" ? job.title.trim() : null,
    company: typeof company === "string" && company.trim() !== "" ? company.trim() : null,
    locationRaw,
    description: job.description ? stripTagsToText(job.description) : null,
    datePosted,
    dateModified,
  };
}

function extractTitle(html, jsonLd) {
  if (jsonLd?.title) return jsonLd.title;
  const h1 = String(html ?? "").match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const text = stripTagsToText(h1[1]);
    if (text) return text;
  }
  const titleTag = String(html ?? "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleTag) {
    const text = stripTagsToText(titleTag[1]);
    if (text) return text;
  }
  return null;
}

/**
 * Extract an offer from a public page.
 *
 * Success result: {status: "ok", url, redirectChain, title, company,
 * description, language, languageMethod, languageConfidence,
 * needsReview, publishedAt, updatedAt, firstSeenAt, lastCheckedAt,
 * evidence, truncated}.
 *
 * Failure results never use the word "closed": a 403 is "blocked",
 * timeouts/network/5xx are "unavailable", a generic or too-short page
 * is "insufficient", and a non-https URL is "invalid".
 *
 * @param {string} url
 * @param {{fetchFn?: any, classifyFn?: ((text: string) => Promise<{language: string, confidence?: number}>)|null, timeoutMs?: number, maxBytes?: number}} opts
 */
export async function extractOffer(url, { fetchFn = globalThis.fetch, classifyFn = null, timeoutMs = DEFAULT_EXTRACT_TIMEOUT_MS, maxBytes = DEFAULT_EXTRACT_MAX_BYTES } = {}) {
  const firstSeenAt = new Date().toISOString();
  /** @param {any} extra */
  const base = (extra) => ({
    url,
    redirectChain: [url],
    title: null,
    company: null,
    description: null,
    language: "unknown",
    languageMethod: null,
    languageConfidence: 0,
    needsReview: false,
    publishedAt: null,
    updatedAt: null,
    firstSeenAt,
    lastCheckedAt: new Date().toISOString(),
    evidence: {},
    truncated: false,
    ...extra,
  });
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return base({ status: "invalid", reason: "invalid_url" });
  }
  if (parsed.protocol !== "https:") return base({ status: "invalid", reason: "only https: URLs are allowed" });

  // Follow redirects manually so the chain is recorded (a fetch that
  // follows automatically would hide it). Each hop is still the same
  // unauthenticated GET of a URL derived from the user's URL.
  let current = url;
  const redirectChain = [url];
  let res = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    try {
      res = await fetchFn(current, {
        method: "GET",
        headers: { Accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") return base({ status: "unavailable", redirectChain, reason: "timeout" });
      return base({ status: "unavailable", redirectChain, reason: `network: ${err instanceof Error ? err.message : String(err)}` });
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers?.get?.("location");
      if (!location) return base({ status: "unavailable", redirectChain, reason: `redirect_without_location: http_${res.status}` });
      current = new URL(location, current).toString();
      redirectChain.push(current);
      if (hop === MAX_REDIRECTS) return base({ status: "unavailable", redirectChain, url: current, reason: "too_many_redirects" });
      continue;
    }
    break;
  }
  if (!res) return base({ status: "unavailable", redirectChain, reason: "no_response" });
  if (res.status === 403) return base({ status: "blocked", redirectChain, url: current, reason: "http_403" });
  if (!res.ok) return base({ status: "unavailable", redirectChain, url: current, reason: `http_${res.status}` });

  let body;
  try {
    body = await res.text();
  } catch (err) {
    return base({ status: "unavailable", redirectChain, url: current, reason: `read_failed: ${err instanceof Error ? err.message : String(err)}` });
  }
  const truncated = body.length > maxBytes;
  const html = truncated ? body.slice(0, maxBytes) : body;

  const jsonLd = extractJsonLdJobPosting(html);
  const mainText = extractMainText(html);
  const title = extractTitle(html, jsonLd);
  const company = jsonLd?.company ?? null;
  const description = jsonLd?.description ?? mainText;

  // Generic page / insufficient content: no title, or too little body
  // text to be a real offer description, is reported as such — never
  // padded into an offer.
  if (!title || !description || description.length < MIN_BODY_CHARS) {
    return base({
      status: "insufficient",
      redirectChain,
      url: current,
      reason: !title ? "no_title_found" : "insufficient_content",
      title,
      company,
      description: description || null,
      evidence: { jsonLd: jsonLd ? "jsonld:JobPosting present" : "jsonld:JobPosting absent" },
      truncated,
    });
  }

  // Language from the BODY only (title excluded: it was stripped from
  // mainText above, and JSON-LD descriptions carry no title).
  const local = detectLanguage(description);
  const wordCount = description.split(/\s+/).filter(Boolean).length;
  const confidentLocal = local.language !== "unknown" && local.confidence >= 0.6 && local.hits >= 5 && wordCount >= 40;
  let language = local.language;
  let languageMethod = "local";
  let languageConfidence = local.confidence;
  let needsReview = false;
  if (confidentLocal) {
    language = local.language;
  } else if (classifyFn) {
    try {
      const classified = await classifyFn(description);
      if (classified && SUPPORTED_LANGUAGES.includes(classified.language)) {
        language = classified.language;
        languageMethod = "xai-assisted";
        languageConfidence = typeof classified.confidence === "number" ? classified.confidence : local.confidence;
        needsReview = languageConfidence < 0.6;
      } else {
        language = "unknown";
        languageMethod = "xai-assisted";
        languageConfidence = 0;
        needsReview = true;
      }
    } catch {
      language = "unknown";
      languageMethod = "xai-assisted";
      languageConfidence = 0;
      needsReview = true;
    }
  } else {
    // Short or mixed text with no classifier available: unknown, and
    // flagged for human review. Guessing a language here would risk
    // admitting a non-English offer to the eligible pipeline (RF-V2-027).
    language = "unknown";
    languageMethod = "local";
    languageConfidence = local.confidence;
    needsReview = true;
  }

  return base({
    status: "ok",
    redirectChain,
    url: current,
    title,
    company,
    description,
    language,
    languageMethod,
    languageConfidence,
    needsReview,
    publishedAt: jsonLd?.datePosted ?? null,
    updatedAt: jsonLd?.dateModified ?? null,
    evidence: {
      title: jsonLd?.title ? "jsonld:title" : "html:h1 or title",
      company: jsonLd?.company ? "jsonld:hiringOrganization.name" : "not provided on page",
      description: jsonLd?.description ? "jsonld:description" : "html:main text",
      publishedAt: jsonLd?.datePosted ? "jsonld:datePosted" : "not published on page: null, never inferred",
      language: `detected from body text, method ${languageMethod}`,
    },
    truncated,
  });
}
