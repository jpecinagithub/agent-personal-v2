// F4 T-V2-035 (RF-V2-041, RF-V2-042, RF-V2-043): offer inspection,
// application-route classification and ATS/tenant recognition.
//
// Deliberate limits, stated here so a caller cannot over-read them:
//  - Inspection never invents an offer: a blocked, paywalled, generic
//    or too-short page is reported with its own status, never as a
//    valid offer. extractOffer already enforces this; inspectExtraction
//    maps its statuses onto the F4 inspection vocabulary and adds a
//    paywall signal scan over supplied page text when the caller has it.
//  - The route classifier works from URL + observable page signals
//    only. It never uses the offer TITLE to pick an ATS adapter: title
//    similarity is not a signal anywhere in this module (RF-V2-043).
//  - ATS recognition is certified only on a STRONG signal (host, API
//    endpoint or form-action host). A weak signal (a brand name merely
//    mentioned in page text) yields ats "unknown" and the generic
//    engine — never a specific adapter.

import { ATS_CAPABILITIES } from "./ats-connectors.mjs";

export const ROUTE_KINDS = [
  "direct_form",
  "wizard",
  "access_registration",
  "external_redirect",
  "aggregator_portal",
  "email_application",
  "process_with_tests",
  "assisted",
];

// Hosts that are aggregators, not the employer's own application form.
// Matching is on exact host or a subdomain of a listed host.
const AGGREGATOR_HOSTS = [
  "linkedin.com", "indeed.com", "glassdoor.com", "infojobs.net",
  "monster.com", "ziprecruiter.com", "simplyhired.com", "jooble.org",
  "talent.com", "jobrapido.com", "x.com", "twitter.com",
];

const PAYWALL_PHRASES = [
  "subscribe to continue", "subscribe to read", "paywall",
  "sign in to continue reading", "create an account to continue",
  "contenido exclusivo", "suscríbete para continuar",
  "this content is for subscribers", "members only",
];

function lower(text) {
  return String(text ?? "").toLowerCase();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isAggregatorHost(host) {
  if (!host) return false;
  return AGGREGATOR_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Scan page text for paywall signals. Returns the matched phrases. */
export function detectPaywallSignals(text) {
  const hay = lower(text);
  return PAYWALL_PHRASES.filter((p) => hay.includes(p));
}

/**
 * Map an extractOffer result onto the F4 inspection vocabulary.
 * @param {any} extraction extractOffer result (or null)
 * @param {{pageText?: string}} [opts] raw page text, when the caller has it
 * @returns {{isOffer: boolean, status: string, reason: string|null, evidence: string[]}}
 */
export function inspectExtraction(extraction, opts = {}) {
  if (!extraction || typeof extraction !== "object") {
    return { isOffer: false, status: "error", reason: "no_extraction", evidence: ["no extraction result supplied"] };
  }
  const paywall = detectPaywallSignals(opts.pageText ?? "");
  if (extraction.status === "ok") {
    if (paywall.length > 0) {
      return { isOffer: false, status: "paywall", reason: "paywall_signals_in_page_text", evidence: paywall.map((p) => `paywall signal: "${p}"`) };
    }
    return {
      isOffer: true, status: "offer", reason: null,
      evidence: [
        `title from ${extraction.evidence?.title ?? "page"}`,
        `description from ${extraction.evidence?.description ?? "page"}`,
        `language: ${extraction.language} (${extraction.languageMethod ?? "local"})`,
        ...(extraction.publishedAt ? [`publishedAt from ${extraction.evidence?.publishedAt ?? "page"}`] : ["publishedAt: not published on page: null, never inferred"]),
      ],
    };
  }
  if (extraction.status === "blocked") {
    return { isOffer: false, status: paywall.length > 0 ? "paywall" : "blocked", reason: extraction.reason ?? "http_403", evidence: [`fetch blocked: ${extraction.reason ?? "http_403"}`, ...paywall.map((p) => `paywall signal: "${p}"`)] };
  }
  if (extraction.status === "insufficient") {
    return { isOffer: false, status: "insufficient", reason: extraction.reason ?? "insufficient_content", evidence: [`insufficient content: ${extraction.reason ?? "insufficient_content"}`] };
  }
  if (extraction.status === "invalid") {
    return { isOffer: false, status: "error", reason: extraction.reason ?? "invalid_url", evidence: [`invalid URL: ${extraction.reason ?? "invalid_url"}`] };
  }
  // "unavailable" and anything else: an error, never a closure and
  // never an offer.
  return { isOffer: false, status: "error", reason: extraction.reason ?? "unavailable", evidence: [`fetch unavailable: ${extraction.reason ?? "unavailable"}`] };
}

// --- ATS recognition -------------------------------------------------------

// Strong signals only certify an ATS. Each entry: host pattern, ATS,
// and the signal label recorded as evidence.
const ATS_HOST_SIGNALS = [
  { test: (h) => h === "boards-api.greenhouse.io" || h.endsWith(".greenhouse.io") || h.endsWith("boards.greenhouse.io"), ats: "greenhouse", label: "host: greenhouse.io board/API" },
  { test: (h) => h === "api.lever.co" || h.endsWith(".lever.co") || h.endsWith("jobs.lever.co"), ats: "lever", label: "host: lever.co board/API" },
  { test: (h) => h === "api.ashbyhq.com" || h.endsWith(".ashbyhq.com") || h.endsWith("jobs.ashbyhq.com"), ats: "ashby", label: "host: ashbyhq.com board/API" },
  { test: (h) => h.endsWith(".myworkdayjobs.com") || h.endsWith("myworkday.com"), ats: "workday", label: "host: workday jobs" },
  { test: (h) => h.endsWith(".smartrecruiters.com"), ats: "smartrecruiters", label: "host: smartrecruiters.com" },
];

const ATS_TEXT_SIGNALS = [
  { test: (t) => t.includes("boards-api.greenhouse.io") || t.includes("greenhouse.io"), ats: "greenhouse", label: "page text/API reference: greenhouse.io" },
  { test: (t) => t.includes("api.lever.co") || t.includes("lever.co"), ats: "lever", label: "page text/API reference: lever.co" },
  { test: (t) => t.includes("api.ashbyhq.com") || t.includes("ashbyhq.com"), ats: "ashby", label: "page text/API reference: ashbyhq.com" },
  { test: (t) => t.includes("myworkdayjobs.com"), ats: "workday", label: "page text reference: myworkdayjobs.com" },
];

export const GENERIC_CAPABILITIES = {
  ats: "generic",
  engine: "generic",
  mode: "generic-form-engine",
  list: false,
  detail: false,
  pagination: "unknown",
  nativeFilters: [],
  customApplicationQuestions: false,
  publishedDate: false,
  note: "Unknown signature: the generic engine is used. No specific adapter is selected, and no capability of a named ATS is claimed.",
};

export function capabilityMatrixFor(ats) {
  if (ats === "greenhouse" || ats === "lever" || ats === "ashby") {
    return { ...ATS_CAPABILITIES[ats], engine: "certified", certified: true };
  }
  return { ...GENERIC_CAPABILITIES, ats: ats ?? "unknown" };
}

/**
 * Recognise ATS/tenant from several signals. Title text is never a
 * signal. A certified ATS needs a strong signal; anything weaker is
 * "unknown" with the generic engine.
 * @param {{url?: string|null, applyUrl?: string|null, redirectChain?: string[], pageText?: string|null, formActionUrl?: string|null}} input
 * @returns {{ats: string, tenant: string|null, signals: string[], strongSignals: number, engine: string, capabilityMatrix: any}}
 */
export function recogniseAts(input = {}) {
  const signals = [];
  const votes = new Map();
  const addVote = (ats, label, strong) => {
    signals.push(label);
    const cur = votes.get(ats) ?? { strong: 0, total: 0 };
    cur.total += 1;
    if (strong) cur.strong += 1;
    votes.set(ats, cur);
  };
  const urls = [input.url, input.applyUrl, input.formActionUrl, ...(input.redirectChain ?? [])].filter(Boolean);
  for (const u of urls) {
    const host = hostOf(u);
    if (!host) continue;
    for (const sig of ATS_HOST_SIGNALS) {
      if (sig.test(host)) addVote(sig.ats, `${sig.label} (url ${host})`, true);
    }
  }
  const text = lower(input.pageText ?? "");
  if (text) {
    for (const sig of ATS_TEXT_SIGNALS) {
      if (sig.test(text)) addVote(sig.ats, sig.label, true);
    }
  }
  // Tenant: the board/site slug, when a known ATS host carries one.
  // Greenhouse boards: jobs.<tenant>.greenhouse.io / boards.greenhouse.io/<tenant>.
  // Lever: jobs.lever.co/<tenant>. Ashby: jobs.ashbyhq.com/<tenant>.
  let tenant = null;
  for (const u of urls) {
    const host = hostOf(u);
    if (!host) continue;
    let m = host.match(/^jobs\.([a-z0-9-]+)\.(greenhouse\.io|lever\.co|ashbyhq\.com)$/);
    if (m) { tenant = m[1]; break; }
    m = String(u).match(/boards\.greenhouse\.io\/([a-z0-9-]+)/i);
    if (m) { tenant = m[1]; break; }
    m = String(u).match(/jobs\.(lever\.co|ashbyhq\.com)\/([a-z0-9-]+)/i);
    if (m) { tenant = m[2]; break; }
  }
  let certified = null;
  for (const [ats, count] of votes) {
    if (count.strong >= 1 && (ats === "greenhouse" || ats === "lever" || ats === "ashby")) { certified = ats; break; }
  }
  if (certified) {
    return { ats: certified, tenant, signals, strongSignals: votes.get(certified).strong, engine: "certified", capabilityMatrix: capabilityMatrixFor(certified) };
  }
  // A non-certified ATS with a strong host signal is recognised by
  // name but still runs on the generic engine: recognition is not
  // certification, and no adapter is claimed for it.
  for (const [ats, count] of votes) {
    if (count.strong >= 1) {
      return { ats, tenant, signals, strongSignals: count.strong, engine: "generic", capabilityMatrix: capabilityMatrixFor(ats) };
    }
  }
  return { ats: "unknown", tenant, signals, strongSignals: 0, engine: "generic", capabilityMatrix: capabilityMatrixFor("unknown") };
}

// --- Route classification --------------------------------------------------

const ROUTE_SIGNALS = {
  email_application: [
    { test: (c) => /mailto:/i.test(c.applyUrl ?? "") || /mailto:/i.test(c.pageText ?? ""), label: "mailto: application address present" },
    { test: (c) => /apply by email|send your cv to|send your resume to|envía tu cv a/i.test(c.pageText ?? ""), label: "page text invites application by email" },
  ],
  process_with_tests: [
    { test: (c) => /hackerrank|codility|hirevue|coding challenge|technical assessment|online test|assessment centre|prueba t[eé]cnica/i.test(c.pageText ?? ""), label: "page mentions a test/assessment stage" },
  ],
  access_registration: [
    { test: (c) => /create an account|sign up to apply|log in to apply|register to apply|inicia sesi[oó]n para postular|regístrate para postular/i.test(c.pageText ?? ""), label: "page requires account creation/login before applying" },
  ],
  wizard: [
    { test: (c) => /step \d+ of \d+|paso \d+ de \d+|multi-step|multip[aá]gina/i.test(c.pageText ?? ""), label: "multi-step wizard markers present" },
    { test: (c) => /next step|siguiente paso/i.test(c.pageText ?? "") && /application form|formulario/i.test(c.pageText ?? ""), label: "wizard navigation ('next step') inside an application form" },
  ],
  direct_form: [
    { test: (c) => /<form/i.test(c.pageText ?? "") && /apply now|apply for this|postular|aplicar ahora/i.test(c.pageText ?? ""), label: "application form with an apply action present" },
    { test: (c) => /upload (your )?(cv|resume)|adjuntar (tu )?cv|upload resume/i.test(c.pageText ?? ""), label: "form asks for a CV/resume upload" },
  ],
};

// Classification order matters: email and tests are the most specific
// signals; a generic/aggregator/redirect decision comes before the
// form-vs-wizard distinction; anything with no usable signal, or a
// captcha gate, falls through to assisted (never a guessed form).
/**
 * @param {{url?: string|null, applyUrl?: string|null, redirectChain?: string[], pageText?: string|null, ats?: any}} input
 */
export function classifyRoute(input = {}) {
  const evidence = [];
  const url = input.url ?? input.applyUrl ?? null;
  const host = hostOf(url);
  const chain = input.redirectChain ?? [];
  const finalHost = chain.length > 0 ? hostOf(chain[chain.length - 1]) : host;
  const ctx = { ...input, pageText: input.pageText ?? "" };

  // Aggregator: the page itself lives on an aggregator host.
  if (isAggregatorHost(host) || isAggregatorHost(finalHost)) {
    evidence.push(`aggregator host: ${finalHost ?? host}`);
    return { route: "aggregator_portal", evidence, assisted: false };
  }
  // External redirect: the chain leaves the original host for a
  // different host (typically the employer's ATS board).
  if (chain.length > 1) {
    const firstHost = hostOf(chain[0]);
    if (firstHost && finalHost && firstHost !== finalHost) {
      evidence.push(`redirect chain leaves ${firstHost} for ${finalHost}`);
      return { route: "external_redirect", evidence, assisted: false };
    }
  }
  for (const kind of ["email_application", "process_with_tests", "access_registration", "wizard", "direct_form"]) {
    for (const sig of ROUTE_SIGNALS[kind]) {
      if (sig.test(ctx)) evidence.push(sig.label);
    }
    if (evidence.length > 0) {
      // A captcha gate is never auto-filled: it forces assisted even
      // when a form is otherwise visible.
      if (kind !== "access_registration" && /captcha|recaptcha/i.test(ctx.pageText ?? "")) {
        evidence.push("captcha/verification gate present (assisted, not auto-filled)");
        return { route: "assisted", evidence, assisted: true, reason: "captcha_gate" };
      }
      return { route: kind, evidence, assisted: false };
    }
  }
  return { route: "assisted", evidence: ["no route signal found: offered as assisted, not guessed"], assisted: true, reason: "no_signal" };
}

/**
 * Full F4 inspection: extraction status + route + ATS, in one object.
 * @param {any} input
 */
export function analyseRoute(input = {}) {
  const inspection = inspectExtraction(input.extraction, { pageText: input.pageText });
  const ats = recogniseAts(input);
  const routeInput = { ...input, ats };
  const route = inspection.isOffer ? classifyRoute(routeInput) : { route: "assisted", evidence: [`not classified as a form route: inspection status is ${inspection.status}`], assisted: true, reason: inspection.status };
  return { inspection, route, ats, url: input.url ?? input.extraction?.url ?? null };
}
