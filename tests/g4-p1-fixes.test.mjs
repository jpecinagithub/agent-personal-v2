// G4 P1 adversarial tests (user reproductions on c63f1dc, 2026-10-29).
// Each test reproduces the user's exact case and asserts the fixed
// behaviour. Synthetic fixtures only; no real network, no attempts,
// no submissions.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { createProfileFull } from "../packages/shared/profiles.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import { recogniseAts } from "../packages/shared/route-classify.mjs";
import { executeChatTool } from "../packages/shared/chat-tools.mjs";
import { createPlan, runPlanDryRun, listExecutions, proposeAdaptation, listAdaptations } from "../packages/shared/application-plan.mjs";
import { recordComparison } from "../packages/shared/requirements.mjs";
import { createAttempt } from "../packages/shared/profiles.mjs";
import { buildProfileView, createSearchDefinition, updateSearchDefinition } from "../packages/shared/search-run.mjs";
import { runF4Flow } from "../packages/shared/f4-flow.mjs";
import { createServer } from "../apps/server/server.mjs";

function setup(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personA = createPersonFull(db, FIXTURE_PERSON);
  const personB = createPersonFull(db, { ...FIXTURE_PERSON, full_name: "Second Person", email: "second@example.test" });
  const profileA = createProfileFull(db, personA, "Finance A", { focus: "Finance" });
  const profileB = createProfileFull(db, personB, "Finance B", { focus: "Finance" });
  return { db, personA, personB, profileA, profileB };
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

const STEPS = [
  { id: "step-1", title: "Observe the offer page", kind: "observe_page", observableInput: "offer page", observableOutput: "title visible" },
];

// --- Defect 1: remote page text must never certify an ATS adapter ---
test("P1: foreign URL + ATS hostname in page text is generic, never certified", () => {
  for (const [text, ats] of [
    ["We hire through boards-api.greenhouse.io for all roles.", "greenhouse"],
    ["Apply via api.lever.co today.", "lever"],
    ["See api.ashbyhq.com for openings.", "ashby"],
    ["Our jobs are on myworkdayjobs.com.", "workday"],
  ]) {
    const r = recogniseAts({ url: "https://evil.example/careers/1", pageText: text });
    assert.equal(r.engine, "generic", `page text must not certify (${ats})`);
    assert.equal(r.ats, "unknown", `page text must not name an ATS (${ats})`);
    assert.notEqual(r.capabilityMatrix.engine, "certified");
  }
});

test("P1: a genuine certified board host still certifies", () => {
  const r = recogniseAts({ url: "https://boards.greenhouse.io/acme/jobs/1", pageText: "Apply now" });
  assert.equal(r.engine, "certified");
  assert.equal(r.ats, "greenhouse");
});

// --- Defect 2: start_job allowlist + per-type payload validation ---
test("P1: start_job rejects arbitrary kinds and smuggled payloads, writing nothing", async () => {
  const { db } = setup("agentv2-g4p1-job-");
  const jobs = () => count(db, "jobs");
  await assert.rejects(executeChatTool(db, "start_job", { kind: "submit_application", payload: { target: "https://attacker.invalid", approved: false } }));
  assert.equal(jobs(), 0, "the user-reproduced case must write no job row");
  await assert.rejects(executeChatTool(db, "start_job", { kind: "run_anything", payload: {} }));
  assert.equal(jobs(), 0);
  await assert.rejects(executeChatTool(db, "start_job", { kind: "search" }));
  await assert.rejects(executeChatTool(db, "start_job", { kind: "search", payload: { definitionId: "d1", approved: true } }));
  await assert.rejects(executeChatTool(db, "start_job", { kind: "search", payload: { definitionId: "d1", target: "https://attacker.invalid" } }));
  assert.equal(jobs(), 0);
  const ok = await executeChatTool(db, "start_job", { kind: "search", payload: { definitionId: "d1" } });
  assert.equal(ok.result.kind, "search");
  assert.equal(jobs(), 1);
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(String(ok.result.jobId));
  assert.deepEqual(JSON.parse(String(row.payload_json)), { definitionId: "d1" });
});

// --- Defect 3: person/profile ownership, domain + HTTP ---
test("P1: domain functions reject person A + profile of person B, persisting nothing", () => {
  const { db, personA, personB, profileA, profileB } = setup("agentv2-g4p1-own-");
  const offerId = "https://example.test/jobs/1";
  assert.throws(() => createPlan(db, { personId: personA, offerId, profileId: profileB, routeKind: "company_careers", rationale: "mixed" , steps: STEPS }), /does not belong/);
  assert.equal(count(db, "application_plans"), 0);
  assert.throws(() => recordComparison(db, { personId: personA, offerId, chosenProfileId: profileB, assessments: [] }), /does not belong/);
  assert.equal(count(db, "application_comparisons"), 0);
  assert.throws(() => createAttempt(db, personA, profileB, offerId), /does not belong/);
  assert.equal(count(db, "attempts"), 0);
  assert.throws(() => runF4Flow(db, {
    personId: personA, offer: { title: "Finance Manager", canonicalUrl: offerId },
    profileViews: [buildProfileView(db, profileB)], planSteps: STEPS,
  }), /does not belong/);
  assert.equal(count(db, "application_plans"), 0);
  assert.equal(count(db, "application_comparisons"), 0);
  assert.equal(count(db, "plan_executions"), 0);
  // Matching person + profile still works.
  const planId = createPlan(db, { personId: personA, offerId, profileId: profileA, routeKind: "company_careers", rationale: "own", steps: STEPS });
  assert.ok(planId);
  const otherOffer = "https://example.test/jobs/2";
  const compId = recordComparison(db, { personId: personB, offerId: otherOffer, chosenProfileId: profileB, assessments: [] });
  assert.ok(compId);
});

test("P1: search definitions reject profiles of another person", () => {
  const { db, personA, profileB } = setup("agentv2-g4p1-def-");
  const base = {
    name: "Mixed", profileIds: [profileB], titles: { any: ["Finance Manager"] },
    locations: { countries: ["ES"] }, workModes: ["remote", "hybrid"],
    sources: ["greenhouse-catalog"], action: "save",
    schedule: { timezone: "Europe/Madrid", localTimes: ["09:00"], enabled: false },
    limits: { maxJobs: 10, maxPagesPerSource: 1 },
  };
  assert.throws(() => createSearchDefinition(db, { personId: personA, ...base }), /does not belong/);
  assert.equal(count(db, "search_definitions"), 0);
  const { db: db2, personA: a2, profileA: pa2, profileB: pb2 } = setup("agentv2-g4p1-def2-");
  const def = createSearchDefinition(db2, { personId: a2, ...base, profileIds: [pa2] });
  assert.throws(() => updateSearchDefinition(db2, def.id, { profileIds: [pb2] }), /does not belong/);
  assert.deepEqual(JSON.parse(String(db2.prepare("SELECT profile_ids_json FROM search_definitions WHERE id = ?").get(String(def.id)).profile_ids_json)), [pa2]);
});

test("P1: an adaptation may not reference another plan's execution", () => {
  const { db, personA, personB, profileA, profileB } = setup("agentv2-g4p1-adapt-");
  const planA = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/a", profileId: profileA, routeKind: "company_careers", rationale: "a", steps: STEPS });
  const planB = createPlan(db, { personId: personB, offerId: "https://example.test/jobs/b", profileId: profileB, routeKind: "company_careers", rationale: "b", steps: STEPS });
  runPlanDryRun(db, planB, {});
  const execB = listExecutions(db, planB)[0];
  assert.ok(execB);
  assert.throws(() => proposeAdaptation(db, { planId: planA, executionId: execB.id, reason: "cross-plan" }), /does not belong to this plan/);
  assert.equal(count(db, "plan_adaptations"), 0);
  const own = proposeAdaptation(db, { planId: planA, executionId: null, reason: "own plan note" });
  assert.ok(own);
});

test("P1: HTTP endpoints reject person A + profile of person B", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-g4p1-http-"));
  const { server } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  const post = async (p, body) => {
    const r = await fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  try {
    const a = await post("/api/person", { full_name: "Person A", email: "a@example.test" });
    assert.equal(a.status, 201);
    // NOTE: POST /api/person is a single-person upsert, so a second
    // HTTP person cannot be created; seed person B + profile B
    // directly in the same DB file the server is using, then prove
    // the HTTP endpoints still refuse to mix them.
    const seeded = openDatabase(path.join(dir, "agentv2.db"));
    const personB = createPersonFull(seeded, { full_name: "Person B", email: "b@example.test" });
    const profB = createProfileFull(seeded, personB, "B", { focus: "Finance" });
    const profBId = profB;
    const offer = { title: "Finance Manager", description: "Role.", language: "en", canonicalUrl: "https://example.test/jobs/1" };
    const assess = await post("/api/offers/assess", { personId: a.json.id, profileIds: [profBId], offer });
    assert.ok(assess.status >= 400, `assess must reject mixed ownership, got ${assess.status}`);
    const plan = await post("/api/plans", { personId: a.json.id, offerId: offer.canonicalUrl, profileId: profBId, routeKind: "company_careers", rationale: "mixed", steps: STEPS });
    assert.ok(plan.status >= 400, `createPlan must reject mixed ownership, got ${plan.status}`);
    const flow = await post("/api/f4-flow", { personId: a.json.id, profileIds: [profBId], offer, planSteps: STEPS });
    assert.ok(flow.status >= 400, `f4-flow must reject mixed ownership, got ${flow.status}`);
    const preflight = await post("/api/preflight", { personId: a.json.id, profileId: profBId, offer });
    assert.ok(preflight.status >= 400, `preflight must reject mixed ownership, got ${preflight.status}`);
    const plans = await fetch(`${base}/api/plans?personId=${a.json.id}`);
    assert.deepEqual((await plans.json()).plans, [], "no plan persisted for the mixed call");
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
});

// --- Defect 4: active-time limit measures real elapsed time ---
test("P1: a 1 ms budget with a real ~60 ms observation exhausts the limit", () => {
  const { db, personA, profileA } = setup("agentv2-g4p1-time-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "time", steps: STEPS });
  const spin = () => {
    const start = performance.now();
    while (performance.now() - start < 60) { /* busy observation work */ }
    return "observed";
  };
  // Caller claims 0 ms: the old code recorded 0 and never exhausted.
  const execution = runPlanDryRun(db, planId, {
    limits: { activeTimeBudgetMs: 1 }, activeMsPerStep: 0,
    observeFn: () => spin(),
  });
  assert.equal(execution.state, "stuck", "real elapsed time must exhaust a 1 ms budget");
  assert.ok(execution.usage.activeMs >= 50, `recorded activeMs must reflect real time, got ${execution.usage.activeMs}`);
  assert.match(execution.stoppedReason ?? "", /active_time/);
});

test("P1: declared ms remain a floor (existing simulation behaviour preserved)", () => {
  const { db, personA, profileA } = setup("agentv2-g4p1-floor-");
  const steps = [
    { id: "step-1", title: "Observe", kind: "observe_page", observableInput: "page", observableOutput: "seen" },
    { id: "step-2", title: "Check", kind: "check_field", dependsOn: ["step-1"], observableInput: "form", observableOutput: "listed" },
  ];
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "floor", steps });
  const execution = runPlanDryRun(db, planId, { activeMsPerStep: 1000, limits: { activeTimeBudgetMs: 1500 } });
  assert.equal(execution.state, "stuck", "declared 1000 ms/step still exhausts a 1500 ms budget");
});
