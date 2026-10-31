// Eligible-budget tests (user decision 2026-10-31, G3 conformity
// reopened): the maxJobs cupo counts UNIQUE ELIGIBLE offers only.
// Each test drives the real pipeline with a mock fetch and synthetic
// data only — no live boards, no real xAI, no user data.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { createProfileFull } from "../packages/shared/profiles.mjs";
import {
  createSearchDefinition,
  runSearchDefinition,
  listSearchRuns,
} from "../packages/shared/search-run.mjs";
import { addBoard, verifyBoard } from "../packages/shared/company-catalog.mjs";

const BODY = "We are looking for a candidate to lead the team and manage budgeting, forecasting and reporting across the business. IFRS experience is required for this finance role.";
const BODY_ES = "Buscamos una persona para dirigir el equipo y gestionar el presupuesto de la empresa en España. La persona será responsable de los informes y de las cuentas, y trabajará con los directivos para preparar la información de cada mes.";

function resp(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-elig-"));
  return openDatabase(path.join(dir, "agentv2.db"));
}

function makePerson(db) {
  return createPersonFull(db, { full_name: "Elig Person", email: "elig@example.test" });
}

function makeProfile(db, personId) {
  return createProfileFull(db, personId, "Elig", { desired_roles: ["Finance Manager"], locations: ["ES"], skills: ["IFRS"] });
}

function makeDefinition(db, personId, profileId, patch = {}) {
  return createSearchDefinition(db, {
    personId,
    name: "Elig",
    profileIds: [profileId],
    titles: { any: ["Finance Manager"] },
    locations: { countries: ["ES"], remoteCountries: ["ES"] },
    workModes: ["remote", "hybrid"],
    offerLanguage: "en",
    sources: ["greenhouse-catalog"],
    schedule: { timezone: "Europe/Madrid", localTimes: ["09:00"], enabled: false },
    action: "save",
    limits: { maxJobs: 100, maxPagesPerSource: 10 },
    ...patch,
  });
}

function ghJob(id, title, content = BODY) {
  return { id, title, absolute_url: `https://example.test/jobs/${id}`, location: { name: "Hybrid, Logroño, ES" }, updated_at: "2026-10-27T00:00:00Z", content };
}

// Mock fetch serving the given boards (slug -> jobs). Records every
// board URL requested so tests can prove which boards were consulted.
function ghMock(jobsByBoard, requested) {
  return async (url) => {
    const t = String(url);
    const m = t.match(/\/boards\/([^/]+)\/jobs/);
    if (t.includes("boards-api.greenhouse.io") && m) {
      requested.push(m[1]);
      return resp(200, jobsByBoard[m[1]] ?? []);
    }
    return resp(404, { error: "not found" });
  };
}

async function addVerifiedBoard(db, company, board, fetchFn) {
  const row = addBoard(db, { company, ats: "greenhouse", board });
  const ver = await verifyBoard(db, row.id, { fetchFn });
  assert.equal(ver.ok, true, JSON.stringify(ver));
  return row;
}

test("eligible budget: ineligible offers do not consume cupo, the run reaches a later board", async () => {
  const db = freshDb();
  const personId = makePerson(db);
  const profileId = makeProfile(db, personId);
  const requested = [];
  const fetchFn = ghMock({
    aaa: [ghJob("a-1", "Account Executive"), ghJob("a-2", "Product Manager"), ghJob("a-3", "Sales Lead")],
    bbb: [ghJob("b-1", "Finance Manager")],
  }, requested);
  await addVerifiedBoard(db, "Aaa Corp", "aaa", fetchFn);
  await addVerifiedBoard(db, "Bbb Corp", "bbb", fetchFn);
  requested.length = 0;
  const def = makeDefinition(db, personId, profileId, { limits: { maxJobs: 1, maxPagesPerSource: 10 } });
  const out = await runSearchDefinition(db, def.id, { fetchFn });
  assert.equal(out.locked, false);
  assert.ok(requested.includes("aaa") && requested.includes("bbb"), "both boards must be consulted: " + JSON.stringify(requested));
  const perSource = out.summary.perSource.find((s) => s.source === "greenhouse-catalog");
  assert.equal(perSource.observed, 4);
  assert.equal(perSource.eligible, 1);
  const run = listSearchRuns(db, { definitionId: def.id }).find((r) => r.id === out.runId);
  assert.equal(run.counts.eligible, 1);
  assert.deepEqual(out.perProfile[0].ranked.map((r) => r.offer.title), ["Finance Manager"]);
});

test("eligible budget: cupo reached mid-board stops later boards", async () => {
  const db = freshDb();
  const personId = makePerson(db);
  const profileId = makeProfile(db, personId);
  const requested = [];
  const fetchFn = ghMock({
    aaa: [ghJob("a-1", "Finance Manager"), ghJob("a-2", "Finance Manager")],
    bbb: [ghJob("b-1", "Finance Manager")],
  }, requested);
  await addVerifiedBoard(db, "Aaa Corp", "aaa", fetchFn);
  await addVerifiedBoard(db, "Bbb Corp", "bbb", fetchFn);
  requested.length = 0;
  const def = makeDefinition(db, personId, profileId, { limits: { maxJobs: 1, maxPagesPerSource: 10 } });
  const out = await runSearchDefinition(db, def.id, { fetchFn });
  assert.deepEqual(requested, ["aaa"], "the second board must never be fetched once the cupo is full");
  const perSource = out.summary.perSource.find((s) => s.source === "greenhouse-catalog");
  assert.equal(perSource.observed, 1);
  assert.equal(perSource.eligible, 1);
});

test("eligible budget: an already-sent offer does not consume cupo", async () => {
  const db = freshDb();
  const personId = makePerson(db);
  const profileId = makeProfile(db, personId);
  const requested = [];
  const fetchFn = ghMock({
    acme: [ghJob("g-sent", "Finance Manager"), ghJob("g-new", "Finance Manager")],
  }, requested);
  await addVerifiedBoard(db, "Acme", "acme", fetchFn);
  // Pre-record g-sent as already sent (attempts join offers, with the
  // ATS strong identity in evidence_json, exactly as the pipeline reads it).
  const offerId = randomUUID();
  db.prepare("INSERT INTO offers (id, source, ats, canonical_url, apply_url, title, company, location, language, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    offerId, "greenhouse", "greenhouse", "https://example.test/jobs/g-sent", "https://example.test/jobs/g-sent",
    "Finance Manager", "Acme", "", "", JSON.stringify({ ats: "greenhouse", tenant: "acme", postingId: "g-sent" }));
  db.prepare("INSERT INTO attempts (id, person_id, profile_id, offer_id) VALUES (?, ?, ?, ?)").run(randomUUID(), personId, profileId, offerId);
  const def = makeDefinition(db, personId, profileId, { limits: { maxJobs: 1, maxPagesPerSource: 10 } });
  const out = await runSearchDefinition(db, def.id, { fetchFn });
  const run = listSearchRuns(db, { definitionId: def.id }).find((r) => r.id === out.runId);
  const counts = run.counts;
  assert.equal(counts.observed, 2);
  assert.equal(counts.eligible, 1, "the already-sent offer must not consume the single slot");
  assert.equal(counts.sentExcluded, 1);
  assert.deepEqual(out.perProfile[0].ranked.map((r) => r.offer.canonicalUrl), ["https://example.test/jobs/g-new"]);
});

test("counts: observed counts everything fetched, eligible counts unique eligible only", async () => {
  const db = freshDb();
  const personId = makePerson(db);
  const profileId = makeProfile(db, personId);
  const requested = [];
  const fetchFn = ghMock({
    acme: [ghJob("e-1", "Finance Manager"), ghJob("e-2", "Finance Manager"),
      ghJob("x-1", "Account Executive"), ghJob("x-2", "Product Manager"), ghJob("x-3", "Sales Lead")],
  }, requested);
  await addVerifiedBoard(db, "Acme", "acme", fetchFn);
  const def = makeDefinition(db, personId, profileId, { limits: { maxJobs: 100, maxPagesPerSource: 10 } });
  const out = await runSearchDefinition(db, def.id, { fetchFn });
  const run = listSearchRuns(db, { definitionId: def.id }).find((r) => r.id === out.runId);
  const counts = run.counts;
  assert.equal(counts.observed, 5);
  assert.equal(counts.eligible, 2);
  const perSource = out.summary.perSource.find((s) => s.source === "greenhouse-catalog");
  assert.equal(perSource.observed, 5);
  assert.equal(perSource.eligible, 2);
});

test("eligible budget: two copies of the same eligible offer consume a single slot", async () => {
  const db = freshDb();
  const personId = makePerson(db);
  const profileId = makeProfile(db, personId);
  const requested = [];
  const dup = ghJob("dup-1", "Finance Manager");
  const fetchFn = ghMock({
    acme: [dup, { ...dup }],
    bbb: [ghJob("b-1", "Finance Manager")],
  }, requested);
  await addVerifiedBoard(db, "Acme", "acme", fetchFn);
  await addVerifiedBoard(db, "Bbb Corp", "bbb", fetchFn);
  requested.length = 0;
  const def = makeDefinition(db, personId, profileId, { limits: { maxJobs: 2, maxPagesPerSource: 10 } });
  const out = await runSearchDefinition(db, def.id, { fetchFn });
  assert.ok(requested.includes("bbb"), "the duplicate must not exhaust the cupo before the second board: " + JSON.stringify(requested));
  const run = listSearchRuns(db, { definitionId: def.id }).find((r) => r.id === out.runId);
  const counts = run.counts;
  assert.equal(counts.observed, 3);
  assert.equal(counts.eligible, 2, "the two copies share one strong identity and consume one slot");
  assert.equal(out.perProfile[0].ranked.length, 2, "dedupe keeps one copy of the duplicated offer plus the second board's offer");
});

test("eligible budget: an offer first seen without a language, detected as non-English, does not consume cupo", async () => {
  const db = freshDb();
  const personId = makePerson(db);
  const profileId = makeProfile(db, personId);
  const requested = [];
  const fetchFn = ghMock({
    aaa: [ghJob("a-es", "Finance Manager", BODY_ES)],
    bbb: [ghJob("b-1", "Finance Manager")],
  }, requested);
  await addVerifiedBoard(db, "Aaa Corp", "aaa", fetchFn);
  await addVerifiedBoard(db, "Bbb Corp", "bbb", fetchFn);
  requested.length = 0;
  const def = makeDefinition(db, personId, profileId, { limits: { maxJobs: 1, maxPagesPerSource: 10 } });
  const out = await runSearchDefinition(db, def.id, { fetchFn });
  assert.ok(requested.includes("bbb"), "the Spanish offer must not consume the single slot: " + JSON.stringify(requested));
  const run = listSearchRuns(db, { definitionId: def.id }).find((r) => r.id === out.runId);
  assert.equal(run.counts.eligible, 1);
  assert.deepEqual(out.perProfile[0].ranked.map((r) => r.offer.canonicalUrl), ["https://example.test/jobs/b-1"]);
});

test("page limit: a source stops after maxPagesPerSource boards with an explicable cause", async () => {
  const db = freshDb();
  const personId = makePerson(db);
  const profileId = makeProfile(db, personId);
  const requested = [];
  const jobsByBoard = {};
  for (let i = 1; i <= 12; i += 1) {
    const slug = `b${String(i).padStart(2, "0")}`;
    jobsByBoard[slug] = [ghJob(`${slug}-1`, "Finance Manager")];
  }
  const fetchFn = ghMock(jobsByBoard, requested);
  for (let i = 1; i <= 12; i += 1) {
    const slug = `b${String(i).padStart(2, "0")}`;
    await addVerifiedBoard(db, `B${String(i).padStart(2, "0")}`, slug, fetchFn);
  }
  requested.length = 0;
  const def = makeDefinition(db, personId, profileId, { limits: { maxJobs: 100, maxPagesPerSource: 10 } });
  const out = await runSearchDefinition(db, def.id, { fetchFn });
  assert.equal(requested.length, 10, "only 10 boards may be consulted under the page budget: " + JSON.stringify(requested));
  assert.ok(!requested.includes("b11") && !requested.includes("b12"));
  const run = listSearchRuns(db, { definitionId: def.id }).find((r) => r.id === out.runId);
  const counts = run.counts;
  assert.equal(counts.budgetTruncated, true, "the page stop must leave budgetTruncated set");
  assert.equal(counts.eligible, 10);
  // Status semantics are unchanged (a page-limited source still
  // reports "completed"); explicability comes from the recorded
  // cause, which the UI status line now shows.
  const perSource = out.summary.perSource.find((s) => s.source === "greenhouse-catalog");
  assert.equal(perSource.status, "completed");
  assert.match(perSource.cause ?? "", /page limit/);
  assert.ok(out.summary.causes.some((c) => c.source === "greenhouse-catalog" && /page limit/.test(c.cause ?? "")),
    "the page-limit cause must reach summary.causes: " + JSON.stringify(out.summary.causes));
});

test("eligible budget: a full cupo skips xai-web without calling its search", async () => {
  const db = freshDb();
  const personId = makePerson(db);
  const profileId = makeProfile(db, personId);
  const requested = [];
  const fetchFn = ghMock({ aaa: [ghJob("a-1", "Finance Manager")] }, requested);
  await addVerifiedBoard(db, "Aaa Corp", "aaa", fetchFn);
  requested.length = 0;
  const def = makeDefinition(db, personId, profileId, { sources: ["greenhouse-catalog", "xai-web"], limits: { maxJobs: 1, maxPagesPerSource: 10 } });
  let xaiCalls = 0;
  const xaiSearchFn = async () => { xaiCalls += 1; return []; };
  const out = await runSearchDefinition(db, def.id, { fetchFn, xaiSearchFn });
  assert.equal(xaiCalls, 0, "xai-web must not be searched once the cupo is full");
  const xai = out.summary.perSource.find((s) => s.source === "xai-web");
  assert.equal(xai.status, "skipped_budget");
  assert.equal(xai.observed, 0);
  assert.equal(xai.eligible, 0);
  assert.match(xai.cause ?? "", /maxJobs=1/);
  assert.equal(out.summary.coverage, "partial", "a skipped source must not leave coverage complete");
  assert.ok(out.summary.causes.some((c) => c.source === "xai-web" && /eligible budget exhausted/.test(c.cause ?? "")),
    "the skip cause must reach summary.causes: " + JSON.stringify(out.summary.causes));
  const run = listSearchRuns(db, { definitionId: def.id }).find((r) => r.id === out.runId);
  assert.equal(run.counts.budgetTruncated, true);
  assert.equal(run.status, "partial");
});

test("eligible budget: a full cupo skips a later ATS instead of reporting completed_zero_results", async () => {
  const db = freshDb();
  const personId = makePerson(db);
  const profileId = makeProfile(db, personId);
  const leverRequested = [];
  const leverPosting = {
    id: "lv-1", text: "Finance Manager", hostedUrl: "https://example.test/jobs/lv-1",
    applyUrl: "https://example.test/jobs/lv-1/apply",
    categories: { location: "Hybrid, Logroño, ES", commitment: "Full-time", team: "Finance" },
    descriptionPlain: BODY, createdAt: "2026-10-27T00:00:00Z",
  };
  const fetchFn = async (url) => {
    const t = String(url);
    const m = t.match(/\/boards\/([^/]+)\/jobs/);
    if (t.includes("boards-api.greenhouse.io") && m) return resp(200, m[1] === "aaa" ? [ghJob("a-1", "Finance Manager")] : []);
    if (t.includes("api.lever.co")) { leverRequested.push(t); return resp(200, [leverPosting]); }
    return resp(404, { error: "not found" });
  };
  await addVerifiedBoard(db, "Aaa Corp", "aaa", fetchFn);
  const leverBoard = addBoard(db, { company: "Lev", ats: "lever", board: "levtest" });
  const ver = await verifyBoard(db, leverBoard.id, { fetchFn });
  assert.equal(ver.ok, true, JSON.stringify(ver));
  leverRequested.length = 0;
  const def = makeDefinition(db, personId, profileId, { sources: ["greenhouse-catalog", "lever-catalog"], limits: { maxJobs: 1, maxPagesPerSource: 10 } });
  const out = await runSearchDefinition(db, def.id, { fetchFn });
  assert.equal(leverRequested.length, 0, "the second ATS must never be consulted once the cupo is full");
  const lever = out.summary.perSource.find((s) => s.source === "lever-catalog");
  assert.equal(lever.status, "skipped_budget");
  assert.equal(lever.observed, 0);
  assert.equal(lever.eligible, 0);
  assert.match(lever.cause ?? "", /maxJobs=1/);
  assert.equal(out.summary.coverage, "partial", "a skipped source must not leave coverage complete");
  assert.ok(out.summary.causes.some((c) => c.source === "lever-catalog" && /eligible budget exhausted/.test(c.cause ?? "")),
    "the skip cause must reach summary.causes: " + JSON.stringify(out.summary.causes));
  const run = listSearchRuns(db, { definitionId: def.id }).find((r) => r.id === out.runId);
  assert.equal(run.counts.budgetTruncated, true);
  assert.equal(run.status, "partial");
});
