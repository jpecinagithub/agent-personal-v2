// F3 offer extraction (T-V2-031, RF-V2-027/035/037). All network via
// injected mock fetch: no test here touches the real network.
import test from "node:test";
import assert from "node:assert/strict";
import { extractOffer, detectLanguage, extractMainText } from "../packages/shared/offer-extract.mjs";

const EN_BODY = [
  "The finance manager will lead the monthly close process and work with the team across the company.",
  "The role is responsible for reporting, forecasting, budgeting and audit support for the whole group.",
  "We expect strong experience with accounting systems and the ability to explain results to senior leaders.",
  "The successful candidate will manage a small team and improve the controls around the reporting process.",
].join(" ");
const ES_BODY = [
  "El gerente de finanzas liderará el cierre mensual y trabajará con el equipo de toda la empresa.",
  "El puesto es responsable de la elaboración de informes, la previsión, el presupuesto y el apoyo a la auditoría.",
  "Se espera una amplia experiencia con los sistemas contables y la capacidad de explicar los resultados.",
  "La persona seleccionada dirigirá un equipo pequeño y mejorará los controles del proceso de informes.",
].join(" ");

function htmlPage({ h1 = "Finance Manager", body = EN_BODY, extra = "" } = {}) {
  return `<html><head><title>${h1} — Example Corp</title></head><body>
    <nav>NAVWORD Home Jobs About Contact</nav>
    <div class="cookie-banner">COOKIEBANNERWORD Accept all cookies and privacy settings here</div>
    <main><h1>${h1}</h1><p>${body}</p>${extra}</main>
    <footer>FOOTERWORD Terms Privacy Cookies Sitemap</footer>
    <script>var TRACKWORD = 1;</script></body></html>`;
}

function pageRes(html, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => html,
  };
}

function redirectRes(location) {
  return {
    ok: false,
    status: 301,
    headers: { get: (name) => (String(name).toLowerCase() === "location" ? location : null) },
    json: async () => ({}),
    text: async () => "",
  };
}

test("T-V2-031: redirects are followed and the chain plus final URL are recorded", async () => {
  const fetchFn = async (url) => {
    if (url === "https://example.test/old") return redirectRes("https://example.test/new");
    if (url === "https://example.test/new") return pageRes(htmlPage());
    throw new Error(`unexpected URL ${url}`);
  };
  const result = await extractOffer("https://example.test/old", { fetchFn });
  assert.equal(result.status, "ok");
  assert.equal(result.url, "https://example.test/new");
  assert.deepEqual(result.redirectChain, ["https://example.test/old", "https://example.test/new"]);
  assert.equal(result.title, "Finance Manager");
});

test("T-V2-031: menus, cookie banners and footers are stripped from the description", async () => {
  const result = await extractOffer("https://example.test/job", { fetchFn: async () => pageRes(htmlPage()) });
  assert.equal(result.status, "ok");
  assert.doesNotMatch(result.description, /NAVWORD|COOKIEBANNERWORD|FOOTERWORD|TRACKWORD/);
  assert.match(result.description, /monthly close process/);
  assert.equal(extractMainText(htmlPage()), result.description);
});

test("T-V2-031: JSON-LD JobPosting is extracted with evidence, including its published date", async () => {
  const jsonLd = JSON.stringify({
    "@type": "JobPosting",
    title: "Financial Controller",
    hiringOrganization: { name: "Example Corp" },
    jobLocation: { address: { addressLocality: "Madrid", addressCountry: "ES" } },
    description: `<p>${EN_BODY}</p>`,
    datePosted: "2026-10-15",
    dateModified: "2026-10-20",
  });
  const html = `<html><head><script type="application/ld+json">${jsonLd}</script><title>Ignored</title></head><body><main><p>${EN_BODY}</p></main></body></html>`;
  const result = await extractOffer("https://example.test/job", { fetchFn: async () => pageRes(html) });
  assert.equal(result.status, "ok");
  assert.equal(result.title, "Financial Controller");
  assert.equal(result.company, "Example Corp");
  assert.equal(result.publishedAt, "2026-10-15");
  assert.equal(result.updatedAt, "2026-10-20");
  assert.equal(result.evidence.publishedAt, "jsonld:datePosted");
});

test("T-V2-031: a 403 is blocked and a timeout is unavailable — never 'closed'", async () => {
  const blocked = await extractOffer("https://example.test/job", { fetchFn: async () => pageRes("", { status: 403 }) });
  assert.equal(blocked.status, "blocked");
  assert.notEqual(blocked.status, "closed");
  const timeoutErr = new Error("timed out");
  timeoutErr.name = "TimeoutError";
  const unavailable = await extractOffer("https://example.test/job", { fetchFn: async () => { throw timeoutErr; } });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.reason, "timeout");
  const gone = await extractOffer("https://example.test/job", { fetchFn: async () => pageRes("", { status: 404 }) });
  assert.equal(gone.status, "unavailable");
  assert.notEqual(gone.status, "closed");
});

test("T-V2-031: a generic or too-short page is insufficient, not an offer", async () => {
  const generic = await extractOffer("https://example.test/", { fetchFn: async () => pageRes("<html><body><p>Welcome to our site.</p></body></html>") });
  assert.equal(generic.status, "insufficient");
  assert.equal(generic.title, null);
});

test("T-V2-031: dates stay separate — no published date means null, never inferred", async () => {
  const result = await extractOffer("https://example.test/job", { fetchFn: async () => pageRes(htmlPage()) });
  assert.equal(result.status, "ok");
  assert.equal(result.publishedAt, null);
  assert.equal(result.updatedAt, null);
  assert.ok(result.firstSeenAt);
  assert.ok(result.lastCheckedAt);
  assert.match(result.evidence.publishedAt, /never inferred/);
});

test("T-V2-031/RF-V2-027: an English offer with a non-English title passes; a non-English offer with an English title fails", async () => {
  const englishOffer = await extractOffer("https://example.test/job", { fetchFn: async () => pageRes(htmlPage({ h1: "Gerente de Finanzas", body: EN_BODY })) });
  assert.equal(englishOffer.status, "ok");
  assert.equal(englishOffer.language, "en");
  assert.equal(englishOffer.languageMethod, "local");
  assert.equal(englishOffer.needsReview, false);
  const spanishOffer = await extractOffer("https://example.test/job", { fetchFn: async () => pageRes(htmlPage({ h1: "Finance Manager", body: ES_BODY })) });
  assert.equal(spanishOffer.status, "ok");
  assert.equal(spanishOffer.language, "es");
  assert.equal(detectLanguage(ES_BODY).language, "es");
  assert.equal(detectLanguage(EN_BODY).language, "en");
});

test("T-V2-031/RF-V2-027: mixed-language text is unknown and flagged for review", async () => {
  const mixed = `${EN_BODY} ${ES_BODY}`;
  const result = await extractOffer("https://example.test/job", { fetchFn: async () => pageRes(htmlPage({ body: mixed })) });
  assert.equal(result.language, "unknown");
  assert.equal(result.needsReview, true);
});

test("T-V2-031: short text with an injected classifier uses xai-assisted detection", async () => {
  const nouns = "Finance Manager accounting reporting forecasting budgeting treasury controlling consolidation auditing compliance valuation modeling analysis ";
  const shortBody = nouns.repeat(4);
  assert.ok(shortBody.length >= 200);
  const classifyFn = async (text) => {
    assert.match(text, /Finance Manager/);
    return { language: "en", confidence: 0.9 };
  };
  const result = await extractOffer("https://example.test/job", { fetchFn: async () => pageRes(htmlPage({ body: shortBody })), classifyFn });
  assert.equal(result.status, "ok");
  assert.equal(result.language, "en");
  assert.equal(result.languageMethod, "xai-assisted");
  assert.equal(result.needsReview, false);
});

test("T-V2-031: only https URLs are extracted", async () => {
  let called = false;
  const result = await extractOffer("http://example.test/job", { fetchFn: async () => { called = true; return pageRes(htmlPage()); } });
  assert.equal(result.status, "invalid");
  assert.equal(called, false);
});
