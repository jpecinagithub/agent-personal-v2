// Pliego F3 INTEGRATION: API-level tests with an injected mock fetch
// (no real network). Definition CRUD + duplicate/pause, a run with
// one ATS source mocked and one source failing (partial summary,
// per-source statuses), already-sent exclusion, two profiles ranking
// differently over the same person via presentedHistory, dynamic vs
// fixed history under master-history changes, import provenance,
// extract 403 != closed, and computed benchmark metrics.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "../apps/server/server.mjs";

const ENGLISH_BODY = "We are looking for a candidate to lead the team and manage the monthly close. "
  + "The successful candidate will work with the leadership team and will be responsible for budgeting, "
  + "forecasting and reporting. You will collaborate with colleagues across the business and you will "
  + "support the annual plan. This role offers the opportunity to develop your career with us and to "
  + "work on projects that matter for the whole company.";

const FINANCE_CONTENT = `${ENGLISH_BODY} FP&A and IFRS experience are required for this finance role.`;
const SALES_CONTENT = `${ENGLISH_BODY} Salesforce administration and Salesforce configuration experience are required for this role.`;

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

// Stateful mock: the first Ashby call succeeds (board verification),
// later Ashby calls fail with 500 (a failing source during a run).
const mockState = { ashbyCalls: 0, delayGreenhouse: false };
async function mockFetch(url) {
  const target = String(url);
  if (target.includes("boards-api.greenhouse.io") && target.includes("/boards/acme/jobs")) {
    if (mockState.delayGreenhouse) await new Promise((r) => setTimeout(r, 300));
    return response(200, [
      { id: "gh-fin", title: "Finance Manager", absolute_url: "https://example.test/jobs/gh-fin", location: { name: "Hybrid, Logroño, ES" }, updated_at: "2026-10-27T00:00:00Z", content: FINANCE_CONTENT },
      { id: "gh-sales", title: "Salesforce Administrator", absolute_url: "https://example.test/jobs/gh-sales", location: { name: "Remote, ES" }, updated_at: "2026-10-27T00:00:00Z", content: SALES_CONTENT },
      { id: "gh-fpa", title: "FP&A Manager", absolute_url: "https://example.test/jobs/gh-fpa", location: { name: "Hybrid, Logroño, ES" }, updated_at: "2026-10-27T00:00:00Z", content: FINANCE_CONTENT },
    ]);
  }
  if (target.includes("api.ashbyhq.com")) {
    mockState.ashbyCalls += 1;
    if (mockState.ashbyCalls === 1) return response(200, []);
    return response(500, { error: "boom" });
  }
  if (target === "https://example.test/jobs/imp-page") {
    const html = `<html><head><title>Finance Manager</title><script type="application/ld+json">`
      + JSON.stringify({ "@type": "JobPosting", title: "Finance Manager", hiringOrganization: { name: "Acme Import" }, datePosted: "2026-10-20", description: FINANCE_CONTENT })
      + `</script></head><body><h1>Finance Manager</h1><p>${FINANCE_CONTENT}</p></body></html>`;
    return response(200, html);
  }
  if (target === "https://example.test/blocked") return response(403, "forbidden");
  return response(404, { error: "not found" });
}

async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-search-int-"));
  const { server, db } = createServer({ dataDir: dir, fetchFn: mockFetch });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const base = `http://127.0.0.1:${port}`;
  const api = async (method, pathname, body) => {
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  };
  return { server, db, api };
}

const app = await startApp();
const { api, db } = app;
let personId;
let financeProfileId;
let salesProfileId;
let dynamicProfileId;
let definitionId;
let run1;

test("integration: person, profiles, catalog boards and verification (mock fetch only)", async () => {
  const person = await api("POST", "/api/person", {
    full_name: "Test Person",
    email: "test.person@example.test",
    authorisations: [{ country: "ES", status: "authorised" }],
    employment: [
      { id: "job-fin", employer: "Acme Test Corp", title: "Finance Manager", start: "2020-01", end: "2025-12" },
      { id: "job-sales", employer: "Globex Test Ltd", title: "Salesforce Administrator", start: "2018-01", end: "2019-12" },
    ],
    education: [{ id: "edu-1", institution: "Fixture University", title: "BSc Finance", start: "2014", end: "2018" }],
  });
  assert.equal(person.status, 201, JSON.stringify(person.data));
  personId = person.data.id;
  const finance = await api("POST", "/api/profiles", {
    personId, name: "Finanzas",
    body: { desired_roles: ["Finance Manager", "FP&A Manager"], locations: ["ES", "Logroño"], skills: ["FP&A", "IFRS"], employment_ids: ["job-fin"] },
  });
  assert.equal(finance.status, 201, JSON.stringify(finance.data));
  financeProfileId = finance.data.id;
  const sales = await api("POST", "/api/profiles", {
    personId, name: "Salesforce",
    body: { desired_roles: ["Salesforce Administrator"], locations: ["ES"], skills: ["Salesforce"], employment_ids: ["job-sales"] },
  });
  assert.equal(sales.status, 201, JSON.stringify(sales.data));
  salesProfileId = sales.data.id;
  const dynamic = await api("POST", "/api/profiles", {
    personId, name: "Dinámico",
    body: { desired_roles: ["Finance Manager", "FP&A Manager"], locations: ["ES", "Logroño"], skills: ["FP&A", "IFRS"] },
  });
  assert.equal(dynamic.status, 201, JSON.stringify(dynamic.data));
  dynamicProfileId = dynamic.data.id;
  const gh = await api("POST", "/api/company-boards", { company: "Acme Test", ats: "greenhouse", board: "acme" });
  assert.equal(gh.status, 201, JSON.stringify(gh.data));
  const ashby = await api("POST", "/api/company-boards", { company: "Ashby Test", ats: "ashby", board: "ashbyco" });
  assert.equal(ashby.status, 201, JSON.stringify(ashby.data));
  const ghVerify = await api("POST", `/api/company-boards/${gh.data.board.id}/verify`, {});
  assert.equal(ghVerify.data.ok, true, JSON.stringify(ghVerify.data));
  const ashbyVerify = await api("POST", `/api/company-boards/${ashby.data.board.id}/verify`, {});
  assert.equal(ashbyVerify.data.ok, true, JSON.stringify(ashbyVerify.data));
  const boards = await api("GET", "/api/company-boards?onlyVerified=true");
  assert.equal(boards.data.boards.length, 2);
});

test("integration: definition CRUD, duplicate, pause/resume and connector compile view", async () => {
  const created = await api("POST", "/api/search-definitions", {
    personId,
    name: "Prueba F3",
    profileIds: [financeProfileId, salesProfileId, dynamicProfileId],
    titles: { any: ["Finance Manager", "Salesforce Administrator", "FP&A Manager"], exclude: ["Intern"] },
    locations: { countries: ["ES"], remoteCountries: ["ES"] },
    workModes: ["remote", "hybrid"],
    offerLanguage: "en",
    sources: ["greenhouse-catalog", "ashby-catalog"],
    schedule: { timezone: "Europe/Madrid", localTimes: ["09:00"], enabled: true },
    action: "auto",
    limits: { maxJobs: 100, maxPagesPerSource: 10 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  definitionId = created.data.definition.id;
  const fetched = await api("GET", `/api/search-definitions/${definitionId}`);
  assert.equal(fetched.data.definition.name, "Prueba F3");
  const updated = await api("PUT", `/api/search-definitions/${definitionId}`, { name: "Prueba F3 editada" });
  assert.equal(updated.data.definition.name, "Prueba F3 editada");
  assert.equal(updated.data.definition.version, 2);
  const duplicated = await api("POST", `/api/search-definitions/${definitionId}/duplicate`, {});
  assert.equal(duplicated.status, 201);
  assert.match(duplicated.data.definition.name, /copia/);
  assert.notEqual(duplicated.data.definition.id, definitionId);
  const paused = await api("POST", `/api/search-definitions/${definitionId}/pause`, {});
  assert.equal(paused.data.definition.paused, true);
  const resumed = await api("POST", `/api/search-definitions/${definitionId}/resume`, {});
  assert.equal(resumed.data.definition.paused, false);
  const deleted = await api("DELETE", `/api/search-definitions/${duplicated.data.definition.id}`, undefined);
  assert.equal(deleted.status, 200);
  assert.equal((await api("GET", `/api/search-definitions/${duplicated.data.definition.id}`)).status, 404);
  // Connector compile view: native / postprocessed / unsupported legend.
  const connectors = await api("GET", `/api/search-connectors?definitionId=${definitionId}`);
  assert.equal(connectors.status, 200, JSON.stringify(connectors.data));
  assert.ok(connectors.data.legend.native.includes("nativo"));
  assert.ok(connectors.data.legend.postprocessed.includes("procesado"));
  assert.ok(connectors.data.legend.unsupported.includes("no disponible"));
  const ghCompile = connectors.data.compile.find((c) => c.compile?.connectorId === "greenhouse-catalog");
  assert.ok(ghCompile, JSON.stringify(connectors.data.compile));
  assert.ok("titles" in ghCompile.compile.nativeQuery, "title is native for the ATS catalog");
  assert.ok(ghCompile.compile.postprocessed.includes("workModes"), "work mode is postprocessed");
  assert.ok(ghCompile.compile.unsupported.includes("authorisation"), "authorisation is profile-side, unsupported by the source");
});

test("integration: run with one mocked ATS source and one failing source is partial, never zero-results", async () => {
  const run = await api("POST", `/api/search-definitions/${definitionId}/run`, {});
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.summary.autoApplyDisabled, true);
  assert.equal(run.data.summary.actionRequested, "auto");
  assert.equal(run.data.summary.actionExecuted, "review");
  assert.equal(run.data.summary.coverage, "partial");
  const gh = run.data.summary.perSource.find((s) => s.source === "greenhouse-catalog");
  const ashby = run.data.summary.perSource.find((s) => s.source === "ashby-catalog");
  assert.equal(gh.status, "completed");
  assert.equal(gh.observed, 3);
  assert.notEqual(ashby.status, "completed");
  assert.match(ashby.cause ?? "", /http_500/);
  assert.ok(run.data.summary.causes.some((c) => c.source === "ashby-catalog"));
  assert.equal(run.data.run.status, "partial");
  // The pipeline creates no attempts: auto-apply stays disabled.
  const attempts = db.prepare("SELECT COUNT(*) AS n FROM attempts").get();
  assert.equal(attempts.n, 0);
  run1 = run.data;
  const runs = await api("GET", `/api/search-runs?definitionId=${definitionId}`);
  assert.ok(runs.data.runs.some((r) => r.id === run.data.runId));
  const single = await api("GET", `/api/search-runs/${run.data.runId}`);
  assert.equal(single.data.run.id, run.data.runId);
});

test("integration: two profiles over the same person rank the same offers differently", async () => {
  const comparison = run1.comparison;
  const finOffer = comparison.find((c) => c.offer.title === "Finance Manager");
  const salesOffer = comparison.find((c) => c.offer.title === "Salesforce Administrator");
  assert.ok(finOffer && salesOffer);
  assert.equal(finOffer.bestProfileId, financeProfileId);
  assert.equal(salesOffer.bestProfileId, salesProfileId);
  const finScore = finOffer.scores.find((s) => s.profileId === financeProfileId).total;
  const salesScoreOnFin = finOffer.scores.find((s) => s.profileId === salesProfileId).total;
  assert.ok(finScore > salesScoreOnFin, `finance profile should outscore salesforce profile on a finance offer (${finScore} vs ${salesScoreOnFin})`);
  // Results endpoint: score is an integer with reasons, per profile.
  const results = await api("GET", `/api/search-results?runId=${run1.runId}&profileId=${financeProfileId}`);
  assert.ok(results.data.results.length > 0);
  for (const row of results.data.results) {
    if (row.score) assert.ok(Number.isInteger(row.score.total), "scores are integers, no false precision");
    assert.ok(Array.isArray(row.reasons) && row.reasons.length > 0);
  }
});

test("integration: already-sent exclusion and dynamic vs fixed history under a master-history change", async () => {
  // Mark the Finance Manager offer as already sent (person + offer).
  const finResults = await api("GET", `/api/search-results?runId=${run1.runId}&profileId=${financeProfileId}`);
  const finRow = finResults.data.results.find((r) => r.offer?.title === "Finance Manager");
  assert.ok(finRow, "finance offer result must exist");
  db.prepare("INSERT INTO attempts (id, person_id, profile_id, offer_id, status, evidence_json) VALUES (?, ?, ?, ?, 'prepared', '{}')")
    .run(randomUUID(), personId, financeProfileId, finRow.offerId);
  // Master-history change: a new FP&A Analyst entry. The dynamic
  // profile presents it (no selection key); the fixed finance
  // profile (employment_ids: [job-fin]) does not.
  const updated = await api("POST", "/api/person", {
    employment: [{ id: "job-fpa", employer: "Initech Test", title: "FP&A Analyst", start: "2016-01", end: "2017-12" }],
  });
  assert.equal(updated.status, 201, JSON.stringify(updated.data));
  const run2 = await api("POST", `/api/search-definitions/${definitionId}/run`, {});
  assert.equal(run2.status, 200, JSON.stringify(run2.data));
  const finResults2 = await api("GET", `/api/search-results?runId=${run2.data.runId}&profileId=${financeProfileId}`);
  const sentRow = finResults2.data.results.find((r) => r.offerId === finRow.offerId);
  assert.ok(sentRow, "already-sent offer must still appear as a result row");
  assert.equal(sentRow.status, "excluded");
  assert.ok(sentRow.reasons.some((r) => String(r).includes("already_sent")));
  assert.ok(run2.data.run.counts.sentExcluded >= 1);
  const scoreOf = (runData, profileId, title) => {
    const profile = runData.perProfile.find((p) => p.profileId === profileId);
    const entry = profile.ranked.find((r) => r.offer.title === title);
    return entry ? entry.total : null;
  };
  const dynBefore = scoreOf(run1, dynamicProfileId, "FP&A Manager");
  const dynAfter = scoreOf(run2.data, dynamicProfileId, "FP&A Manager");
  const fixedBefore = scoreOf(run1, financeProfileId, "FP&A Manager");
  const fixedAfter = scoreOf(run2.data, financeProfileId, "FP&A Manager");
  assert.ok(dynBefore !== null && dynAfter !== null && dynAfter > dynBefore,
    `dynamic profile FP&A score must rise with the new relevant history (${dynBefore} -> ${dynAfter})`);
  assert.equal(fixedAfter, fixedBefore, "fixed profile score must not move with a master-history change it does not present");
});

test("integration: a second concurrent run attempt returns locked, not a duplicate", async () => {
  mockState.delayGreenhouse = true;
  try {
    const [first, second] = await Promise.all([
      api("POST", `/api/search-definitions/${definitionId}/run`, {}),
      api("POST", `/api/search-definitions/${definitionId}/run`, {}),
    ]);
    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const locked = first.status === 409 ? first : second;
    assert.equal(locked.data.locked, true);
    const running = db.prepare("SELECT COUNT(*) AS n FROM search_runs WHERE definition_id = ? AND status = 'running'").get(definitionId);
    assert.ok(Number(running.n) <= 1);
  } finally {
    mockState.delayGreenhouse = false;
  }
});

test("integration: LinkedIn import provenance, never an invented apply URL", async () => {
  const csv = await api("POST", "/api/linkedin/import", {
    kind: "csv",
    payload: "title,company,url,location\nFinance Manager,Acme Import,https://example.test/jobs/imp-1,Logroño",
  });
  assert.equal(csv.status, 201, JSON.stringify(csv.data));
  assert.equal(csv.data.imported[0].provenance, "linkedin-csv-import");
  assert.equal(csv.data.imported[0].applyUrl, "");
  const urlImport = await api("POST", "/api/linkedin/import", { kind: "url", payload: "https://example.test/jobs/imp-page" });
  assert.equal(urlImport.status, 201, JSON.stringify(urlImport.data));
  assert.equal(urlImport.data.imported[0].provenance, "linkedin-import");
  assert.equal(urlImport.data.imported[0].title, "Finance Manager");
  assert.equal(urlImport.data.imported[0].applyUrl, "");
  const built = await api("POST", "/api/linkedin/build-url", { keywords: "Finance Manager", location: "Madrid" });
  assert.match(built.data.url, /linkedin\.com\/jobs\/search/);
  assert.match(built.data.url, /Finance/);
});

test("integration: extract reports 403 as blocked, never as closed", async () => {
  const extracted = await api("POST", "/api/offers/extract", { url: "https://example.test/blocked" });
  assert.equal(extracted.status, 200, JSON.stringify(extracted.data));
  assert.equal(extracted.data.analysis.status, "blocked");
  assert.notEqual(extracted.data.analysis.status, "closed");
  assert.match(extracted.data.analysis.reason ?? "", /403/);
});

test("integration: benchmark metrics are computed, not claimed", async () => {
  const bench = await api("POST", "/api/search-benchmark", {});
  assert.equal(bench.status, 200, JSON.stringify(bench.data));
  const m = bench.data.metrics;
  assert.ok(m.totalOffers >= 60, `benchmark corpus must have >= 60 offers, got ${m.totalOffers}`);
  assert.equal(m.hardExclusionFalsePasses, 0);
  assert.deepEqual(m.falsePassIds, []);
  assert.ok(m.dedupe.duplicates > 0, "benchmark must count strong duplicates");
  assert.ok(m.dedupe.uncertainGroups > 0, "benchmark must count weak groups for review");
  assert.ok(m.unknownDate.total >= 1);
  assert.equal(m.unknownDate.markedUnknown, m.unknownDate.total, "unknown dates must be marked unknown, never assumed recent");
  assert.equal(m.top20.size, 20);
  assert.equal(m.top20.precision, 1);
});

test.after(() => {
  app.server.close();
});
