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
import { createPlan, runPlanDryRun, listExecutions, getExecution, proposeAdaptation, listAdaptations } from "../packages/shared/application-plan.mjs";
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
  const profileA = createProfileFull(db, personA, "Finance A", {});
  const profileB = createProfileFull(db, personB, "Finance B", {});
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
    const profB = createProfileFull(seeded, personB, "B", {});
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

// --- Residual P1 (user reproduction on 8e842c7, 2026-10-29): a FAILED
// observation must still consume real active time, or failures and
// their retries evade the accumulated time budget. The diagnosis is
// preserved alongside the recorded time.
test("P1 residual: a failed observation after ~60 ms of real work records its time", () => {
  const { db, personA, profileA } = setup("agentv2-g4p1-failed-time-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "failed time", steps: STEPS });
  const failAfterWork = () => {
    const start = performance.now();
    while (performance.now() - start < 60) { /* real work, then an error */ }
    throw new Error("network timeout while observing");
  };
  const execution = runPlanDryRun(db, planId, {
    limits: { activeTimeBudgetMs: 1 }, activeMsPerStep: 0,
    observeFn: () => failAfterWork(),
  });
  assert.equal(execution.state, "stuck", "failed observation still ends stuck");
  assert.match(execution.stoppedReason ?? "", /observation failed/, "error diagnosis preserved");
  assert.equal(execution.stepResults[0].status, "observation_failed");
  assert.match(execution.stepResults[0].effect ?? "", /network timeout/, "error message preserved in the step result");
  assert.ok(execution.usage.activeMs >= 50, `failed observation must record real time, got ${execution.usage.activeMs}`);
  const persisted = listExecutions(db, planId).at(-1);
  assert.ok(persisted.usage.activeMs >= 50, `persisted activeMs must reflect the failed observation, got ${persisted.usage.activeMs}`);
  assert.equal(persisted.state, "stuck");
});

// --- Retry budget (G4 P1, user reproduction on 043a3c5, 2026-10-29):
// saving consumption must imply loading it on retry. A retry of the
// same plan + version resumes cumulative counters by default; an
// exhausted starting usage blocks BEFORE observing; only an explicit
// resetBudget restarts the budget.
test("P1 retry: second run without reset recovers prior consumption and blocks before observing", () => {
  const { db, personA, profileA } = setup("agentv2-g4p1-retry-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "retry", steps: STEPS });
  const failAfterWork = () => {
    const start = performance.now();
    while (performance.now() - start < 60) { /* real work, then an error */ }
    throw new Error("network timeout while observing");
  };
  const first = runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 1 }, activeMsPerStep: 0, observeFn: () => failAfterWork() });
  assert.equal(first.state, "stuck", "first run fails after real work");
  assert.ok(first.usage.activeMs >= 50, `first run must persist real time, got ${first.usage.activeMs}`);
  let observedCalls = 0;
  const second = runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 1 }, observeFn: () => { observedCalls += 1; return "x"; } });
  assert.equal(second.state, "stuck", "retry must block on recovered consumption");
  assert.equal(observedCalls, 0, "blocked retry must not observe");
  assert.equal(second.stepResults.length, 0, "blocked retry has zero steps");
  assert.ok(second.usage.activeMs >= first.usage.activeMs, "persisted usage must not shrink across retries");
  const persisted = listExecutions(db, planId).at(-1);
  assert.ok(persisted.usage.activeMs >= first.usage.activeMs, "latest execution row keeps the recovered consumption");
  assert.equal(getExecution(db, second.executionId).state, "stuck");
});

test("P1 retry: exhausted initialUsage blocks before observing", () => {
  const { db, personA, profileA } = setup("agentv2-g4p1-retry-init-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "retry-init", steps: STEPS });
  let observedCalls = 0;
  const execution = runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 1 }, initialUsage: { activeMs: 1000 }, observeFn: () => { observedCalls += 1; return "x"; } });
  assert.equal(execution.state, "stuck", "exhausted starting usage must block");
  assert.equal(observedCalls, 0, "exhausted start must not buy one more observation");
  assert.equal(execution.stepResults.length, 0, "blocked run has zero steps");
  assert.match(execution.stoppedReason ?? "", /active_time/);
});

test("P1 retry: explicit resetBudget restarts fresh and observes normally", () => {
  const { db, personA, profileA } = setup("agentv2-g4p1-retry-reset-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "retry-reset", steps: STEPS });
  const failAfterWork = () => {
    const start = performance.now();
    while (performance.now() - start < 60) { /* real work, then an error */ }
    throw new Error("network timeout while observing");
  };
  const first = runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 1 }, activeMsPerStep: 0, observeFn: () => failAfterWork() });
  assert.equal(first.state, "stuck");
  const reset = runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 1 }, resetBudget: true });
  assert.equal(reset.state, "observed_only", "explicit reset restarts the budget");
  assert.equal(reset.stepResults[0].status, "observed");
  assert.ok(reset.usage.activeMs < 1, `reset run starts from zero, got ${reset.usage.activeMs}`);
});

test("P1 retry via API: repeat /execute without reset blocks, with reset it proceeds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-g4p1-retry-http-"));
  const { server } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  const post = async (p, body) => {
    const r = await fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  try {
    const seeded = openDatabase(path.join(dir, "agentv2.db"));
    const personId = createPersonFull(seeded, { full_name: "Retry Person", email: "retry@example.test" });
    const profileId = createProfileFull(seeded, personId, "Finance", {});
    const plan = await post("/api/plans", { personId, offerId: "https://example.test/jobs/1", profileId, routeKind: "company_careers", rationale: "retry", steps: STEPS });
    assert.equal(plan.status, 201);
    const planId = plan.json.id;
    const first = await post(`/api/plans/${planId}/execute`, { limits: { activeTimeBudgetMs: 1 }, activeMsPerStep: 100 });
    assert.equal(first.json.execution.state, "stuck", "first run exhausts the budget");
    assert.ok(first.json.execution.usage.activeMs >= 100);
    const second = await post(`/api/plans/${planId}/execute`, { limits: { activeTimeBudgetMs: 1 } });
    assert.equal(second.json.execution.state, "stuck", "repeat /execute without reset must block");
    assert.equal(second.json.execution.stepResults.length, 0, "repeat /execute must observe nothing");
    assert.ok(second.json.execution.usage.activeMs >= 100, "repeat /execute keeps the recovered consumption");
    const reset = await post(`/api/plans/${planId}/execute`, { limits: { activeTimeBudgetMs: 1 }, resetBudget: true });
    assert.equal(reset.json.execution.state, "observed_only", "explicit resetBudget via API restarts the budget");
    assert.equal(reset.json.execution.stepResults[0].status, "observed");
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
});

// --- initialUsage precedence (G4 P1, user reproduction on c4547fa,
// 2026-10-29): without an explicit resetBudget, a supplied
// initialUsage must NEVER reduce an accumulated counter. Effective
// starting usage = element-wise maximum of (seeded previous usage,
// supplied initialUsage) over every cumulative counter.
function seedConsumedRun(db, personA, profileA, prefix) {
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: prefix, steps: STEPS });
  // Deterministic consumption: declared 100 ms + 50 tokens + $1 cost (below the default $2 cap).
  const first = runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 100000 }, activeMsPerStep: 100, llmTokensPerStep: 50, llmCostPerStep: 1 });
  assert.equal(first.state, "observed_only");
  assert.ok(first.usage.activeMs >= 100, `seeded activeMs, got ${first.usage.activeMs}`);
  assert.equal(first.usage.llmTokens, 50);
  assert.equal(first.usage.costUsd, 1);
  assert.equal(first.usage.llmCalls, 1);
  return planId;
}

test("P1 initialUsage: empty {} keeps the full previous consumption and blocks", () => {
  const { db, personA, profileA } = setup("agentv2-g4p1-init-empty-");
  const planId = seedConsumedRun(db, personA, profileA, "init-empty");
  let observedCalls = 0;
  const retry = runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 20 }, initialUsage: {}, resetBudget: false, observeFn: () => { observedCalls += 1; return "x"; } });
  assert.equal(retry.state, "stuck", "empty initialUsage must not reset the budget");
  assert.equal(observedCalls, 0, "blocked retry must not observe");
  assert.equal(retry.stepResults.length, 0);
  assert.ok(retry.usage.activeMs >= 100, `previous consumption kept, got ${retry.usage.activeMs}`);
  const persisted = listExecutions(db, planId).at(-1);
  assert.ok(persisted.usage.activeMs >= 100, "persisted usage must not shrink");
});

test("P1 initialUsage: partial { llmCalls: 1 } preserves every previous counter", () => {
  const { db, personA, profileA } = setup("agentv2-g4p1-init-partial-");
  const planId = seedConsumedRun(db, personA, profileA, "init-partial");
  const retry = runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 20 }, initialUsage: { llmCalls: 1 }, resetBudget: false });
  assert.equal(retry.state, "stuck");
  assert.equal(retry.stepResults.length, 0);
  assert.ok(retry.usage.activeMs >= 100, "activeMs preserved");
  assert.equal(retry.usage.llmTokens, 50, "llmTokens preserved");
  assert.equal(retry.usage.costUsd, 1, "costUsd preserved");
  assert.equal(retry.usage.llmCalls, 1, "llmCalls kept at the stored value");
});

test("P1 initialUsage: values lower than stored lose on every counter", () => {
  const { db, personA, profileA } = setup("agentv2-g4p1-init-lower-");
  const planId = seedConsumedRun(db, personA, profileA, "init-lower");
  const retry = runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 20 }, initialUsage: { activeMs: 10, llmTokens: 5, costUsd: 0.5, llmCalls: 0 }, resetBudget: false });
  assert.equal(retry.state, "stuck");
  assert.ok(retry.usage.activeMs >= 100, "stored activeMs wins over 10");
  assert.equal(retry.usage.llmTokens, 50, "stored llmTokens wins over 5");
  assert.equal(retry.usage.costUsd, 1, "stored costUsd wins over 0.5");
  assert.equal(retry.usage.llmCalls, 1, "stored llmCalls wins over 0");
});

test("P1 initialUsage: a higher value on one counter is kept, others stay stored", () => {
  const { db, personA, profileA } = setup("agentv2-g4p1-init-higher-");
  const planId = seedConsumedRun(db, personA, profileA, "init-higher");
  const retry = runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 20 }, initialUsage: { llmTokens: 500 }, resetBudget: false });
  assert.equal(retry.state, "stuck");
  assert.equal(retry.usage.llmTokens, 500, "higher supplied value kept as additional declared consumption");
  assert.ok(retry.usage.activeMs >= 100, "other counters stay at stored values");
  assert.equal(retry.usage.costUsd, 1);
});

test("P1 initialUsage: resetBudget true with {} genuinely restarts from zero", () => {
  const { db, personA, profileA } = setup("agentv2-g4p1-init-reset-");
  const planId = seedConsumedRun(db, personA, profileA, "init-reset");
  const reset = runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 20 }, initialUsage: {}, resetBudget: true });
  assert.equal(reset.state, "observed_only", "explicit reset restarts the budget");
  assert.equal(reset.stepResults[0].status, "observed");
  assert.ok(reset.usage.activeMs < 20, `reset run starts from zero, got ${reset.usage.activeMs}`);
  assert.equal(reset.usage.llmTokens, 0);
});

test("P1 initialUsage via API: user's exact request (budget 20, {}, reset false) blocks with consumption kept", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-g4p1-init-http-"));
  const { server } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  const post = async (p, body) => {
    const r = await fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  try {
    const seeded = openDatabase(path.join(dir, "agentv2.db"));
    const personId = createPersonFull(seeded, { full_name: "Init Person", email: "init@example.test" });
    const profileId = createProfileFull(seeded, personId, "Finance", {});
    const plan = await post("/api/plans", { personId, offerId: "https://example.test/jobs/1", profileId, routeKind: "company_careers", rationale: "init", steps: STEPS });
    assert.equal(plan.status, 201);
    const planId = plan.json.id;
    const first = await post(`/api/plans/${planId}/execute`, { limits: { activeTimeBudgetMs: 20 }, activeMsPerStep: 100 });
    assert.ok(first.json.execution.usage.activeMs >= 100, `first run persists ~100 ms, got ${first.json.execution.usage.activeMs}`);
    // The user's exact request.
    const retry = await post(`/api/plans/${planId}/execute`, { limits: { activeTimeBudgetMs: 20 }, initialUsage: {}, resetBudget: false });
    assert.equal(retry.json.execution.state, "stuck", "exact user request must block");
    assert.equal(retry.json.execution.stepResults.length, 0, "blocked retry has zero steps");
    assert.ok(retry.json.execution.usage.activeMs >= 100, `consumption kept, got ${retry.json.execution.usage.activeMs}`);
    const reset = await post(`/api/plans/${planId}/execute`, { limits: { activeTimeBudgetMs: 20 }, initialUsage: {}, resetBudget: true });
    assert.equal(reset.json.execution.state, "observed_only", "explicit reset via API proceeds");
    assert.equal(reset.json.execution.stepResults[0].status, "observed");
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
});

// --- P2 (user reproduction on cc69b53, 2026-10-29): non-finite usage
// counters must be rejected before anything is persisted, and a
// stored-invalid counter must never silently restart the budget.
test("P2: API rejects initialUsage {activeMs: 1e309} with 400 and alters nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-g4p2-http-"));
  const { server } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  try {
    const seeded = openDatabase(path.join(dir, "agentv2.db"));
    const personId = createPersonFull(seeded, FIXTURE_PERSON);
    const profileId = createProfileFull(seeded, personId, "Finance", {});
    const planId = createPlan(seeded, { personId, offerId: "https://example.test/jobs/1", profileId, routeKind: "company_careers", rationale: "p2", steps: STEPS });
    runPlanDryRun(seeded, planId, { activeMsPerStep: 100, limits: { activeTimeBudgetMs: 1000 } });
    assert.equal(listExecutions(seeded, planId).length, 1);
    assert.equal(listExecutions(seeded, planId)[0].usage.activeMs, 100);
    // Raw body: JSON.stringify(Infinity) would emit null and would NOT
    // reproduce the user's case — the client literally sends 1e309,
    // which JSON parses to Infinity.
    const raw = await fetch(`${base}/api/plans/${planId}/execute`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: `{"limits":{"activeTimeBudgetMs":20},"initialUsage":{"activeMs":1e309},"resetBudget":false}`,
    });
    assert.equal(raw.status, 400, `non-finite counter must be a 400, got ${raw.status}`);
    assert.match((await raw.json()).error ?? "", /finite/);
    assert.equal(listExecutions(seeded, planId).length, 1, "rejected request must create no execution");
    assert.equal(listExecutions(seeded, planId)[0].usage.activeMs, 100, "previous consumption untouched");
    // And a plain retry still sees the intact consumption and blocks.
    const retry = await fetch(`${base}/api/plans/${planId}/execute`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limits: { activeTimeBudgetMs: 20 }, initialUsage: {}, resetBudget: false }),
    });
    const retryJson = await retry.json();
    assert.equal(retryJson.execution.state, "stuck");
    assert.equal(retryJson.execution.stepResults.length, 0, "blocked before observing");
    assert.ok(retryJson.execution.usage.activeMs >= 100);
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
});

test("P2: NaN, negative and Infinity initialUsage are rejected with no execution created", () => {
  const { db, personA, profileA } = setup("agentv2-g4p2-invalid-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "p2", steps: STEPS });
  for (const bad of [{ activeMs: Number.NaN }, { activeMs: -5 }, { activeMs: Infinity }, { costUsd: -Infinity }]) {
    assert.throws(() => runPlanDryRun(db, planId, { initialUsage: bad }), /finite non-negative/);
  }
  assert.equal(listExecutions(db, planId).length, 0, "no rejected run may create an execution");
  // Even the explicit reset path validates: reset authorises a fresh
  // start, not an invalid counter.
  assert.throws(() => runPlanDryRun(db, planId, { initialUsage: { activeMs: Infinity }, resetBudget: true }), /finite non-negative/);
  assert.equal(listExecutions(db, planId).length, 0);
});

test("P2: corrupt latest execution (null activeMs) falls back to the earlier valid one", () => {
  const { db, personA, profileA } = setup("agentv2-g4p2-recover-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "p2", steps: STEPS });
  runPlanDryRun(db, planId, { activeMsPerStep: 100, limits: { activeTimeBudgetMs: 1000 } });
  runPlanDryRun(db, planId, { activeMsPerStep: 0, limits: { activeTimeBudgetMs: 1000 } });
  assert.equal(listExecutions(db, planId).length, 2);
  const corrupt = { activeMs: null, waitMs: 0, llmCalls: 0, llmTokens: 0, costUsd: 0, planChanges: 0, noProgressRepetitions: 0, lastFingerprint: null, lastStepIndex: null };
  db.prepare("UPDATE plan_executions SET usage_json = ? WHERE rowid = (SELECT MAX(rowid) FROM plan_executions WHERE plan_id = ?)").run(JSON.stringify(corrupt), planId);
  const execution = runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 20 }, initialUsage: {}, resetBudget: false });
  assert.equal(execution.state, "stuck", "recovered 100 ms must block against a 20 ms budget");
  assert.equal(execution.stepResults.length, 0, "blocked before observing");
  assert.ok(execution.usage.activeMs >= 100, `must recover the earlier valid consumption, got ${execution.usage.activeMs}`);
});

test("P2: corrupt latest execution with no earlier valid one fails and creates no row", () => {
  const { db, personA, profileA } = setup("agentv2-g4p2-novalid-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "p2", steps: STEPS });
  runPlanDryRun(db, planId, { activeMsPerStep: 100, limits: { activeTimeBudgetMs: 1000 } });
  const corrupt = { activeMs: null, waitMs: 0, llmCalls: 0, llmTokens: 0, costUsd: 0, planChanges: 0, noProgressRepetitions: 0, lastFingerprint: null, lastStepIndex: null };
  db.prepare("UPDATE plan_executions SET usage_json = ? WHERE plan_id = ?").run(JSON.stringify(corrupt), planId);
  assert.throws(() => runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 20 }, initialUsage: {}, resetBudget: false }), /no earlier valid execution/);
  assert.equal(listExecutions(db, planId).length, 1, "failed recovery must create no execution row");
});

test("P2 regression: valid finite initialUsage still merges by max (cc69b53 semantics)", () => {
  const { db, personA, profileA } = setup("agentv2-g4p2-max-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "p2", steps: STEPS });
  runPlanDryRun(db, planId, { activeMsPerStep: 100, limits: { activeTimeBudgetMs: 1000 } });
  const execution = runPlanDryRun(db, planId, { activeMsPerStep: 0, limits: { activeTimeBudgetMs: 1000 }, initialUsage: { activeMs: 50, llmCalls: 3 } });
  assert.ok(execution.usage.activeMs >= 100, `lower supplied activeMs must lose to the stored 100 (plus real measured time), got ${execution.usage.activeMs}`);
  assert.equal(execution.usage.llmCalls, 3, "higher supplied llmCalls must win");
  assert.equal(execution.state, "observed_only");
});

// --- P2 (user reproductions on 7c802cb, 2026-10-29): per-step
// consumption knobs must be validated like initialUsage, and
// stored-invalid recovery must work per counter, not per row.
test("P2: API rejects 1e309 in each per-step knob with 400 and alters nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-g4p2-step-"));
  const { server } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
  try {
    const seeded = openDatabase(path.join(dir, "agentv2.db"));
    const personId = createPersonFull(seeded, FIXTURE_PERSON);
    const profileId = createProfileFull(seeded, personId, "Finance", {});
    const planId = createPlan(seeded, { personId, offerId: "https://example.test/jobs/1", profileId, routeKind: "company_careers", rationale: "p2step", steps: STEPS });
    runPlanDryRun(seeded, planId, { activeMsPerStep: 100, limits: { activeTimeBudgetMs: 1000 } });
    assert.equal(listExecutions(seeded, planId).length, 1);
    for (const knob of ["activeMsPerStep", "llmTokensPerStep", "llmCostPerStep"]) {
      const raw = await fetch(`${base}/api/plans/${planId}/execute`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: `{"limits":{"activeTimeBudgetMs":1000},"${knob}":1e309,"resetBudget":false}`,
      });
      assert.equal(raw.status, 400, `${knob}=1e309 must be a 400, got ${raw.status}`);
      assert.match((await raw.json()).error ?? "", /finite/);
      assert.equal(listExecutions(seeded, planId).length, 1, `rejected ${knob} request must create no execution`);
      assert.equal(listExecutions(seeded, planId)[0].usage.activeMs, 100, "previous consumption untouched");
      assert.equal(listExecutions(seeded, planId)[0].usage.costUsd, 0, "previous cost untouched");
    }
  } finally {
    await new Promise((r) => server.close(() => r(undefined)));
  }
});

test("P2: NaN, negative and Infinity per-step values are rejected, even with resetBudget", () => {
  const { db, personA, profileA } = setup("agentv2-g4p2-stepbad-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "p2step", steps: STEPS });
  for (const bad of [{ activeMsPerStep: Number.NaN }, { activeMsPerStep: -1 }, { llmTokensPerStep: Infinity }, { llmCostPerStep: -Infinity }]) {
    assert.throws(() => runPlanDryRun(db, planId, bad), /finite non-negative/);
  }
  assert.throws(() => runPlanDryRun(db, planId, { activeMsPerStep: Infinity, resetBudget: true }), /finite non-negative/, "reset authorises a fresh start, not an invalid counter");
  assert.equal(listExecutions(db, planId).length, 0, "no rejected run may create an execution");
});

test("P2: per-counter recovery keeps row2 cost 2 when row2 time is null (user loss case)", () => {
  const { db, personA, profileA } = setup("agentv2-g4p2-percounter-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "p2counter", steps: STEPS });
  runPlanDryRun(db, planId, { activeMsPerStep: 100, limits: { activeTimeBudgetMs: 100000 } });
  runPlanDryRun(db, planId, { activeMsPerStep: 0, limits: { activeTimeBudgetMs: 100000 } });
  assert.equal(listExecutions(db, planId).length, 2);
  // Legacy corrupt residue: row2 recorded cost 2 correctly but its
  // time persisted as null (an Infinity that was stored pre-fix).
  const row2 = { activeMs: null, waitMs: 0, llmCalls: 0, llmTokens: 0, costUsd: 2, planChanges: 0, noProgressRepetitions: 0, lastFingerprint: null, lastStepIndex: null };
  db.prepare("UPDATE plan_executions SET usage_json = ? WHERE rowid = (SELECT MAX(rowid) FROM plan_executions WHERE plan_id = ?)").run(JSON.stringify(row2), planId);
  const execution = runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 100000, maxCostUsd: 2 }, initialUsage: {}, resetBudget: false });
  assert.equal(execution.state, "stuck", "recovered cost 2 must exhaust the cost limit 2");
  assert.equal(execution.stepResults.length, 0, "blocked before observing");
  assert.ok(execution.usage.activeMs >= 100, `time must come from row1, got ${execution.usage.activeMs}`);
  assert.equal(execution.usage.costUsd, 2, "cost must come from row2, not be lost by the row fallback");
});

test("P2: wholly-invalid latest row still recovers the earlier valid row (7c802cb regression)", () => {
  const { db, personA, profileA } = setup("agentv2-g4p2-wholly-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "p2wholly", steps: STEPS });
  runPlanDryRun(db, planId, { activeMsPerStep: 100, limits: { activeTimeBudgetMs: 1000 } });
  runPlanDryRun(db, planId, { activeMsPerStep: 0, limits: { activeTimeBudgetMs: 1000 } });
  const allNull = { activeMs: null, waitMs: null, llmCalls: null, llmTokens: null, costUsd: null, planChanges: null, noProgressRepetitions: null, lastFingerprint: null, lastStepIndex: null };
  db.prepare("UPDATE plan_executions SET usage_json = ? WHERE rowid = (SELECT MAX(rowid) FROM plan_executions WHERE plan_id = ?)").run(JSON.stringify(allNull), planId);
  const execution = runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 20 }, initialUsage: {}, resetBudget: false });
  assert.equal(execution.state, "stuck");
  assert.equal(execution.stepResults.length, 0, "blocked before observing");
  assert.ok(execution.usage.activeMs >= 100, `must recover the earlier valid row, got ${execution.usage.activeMs}`);
});

test("P2: no valid value for a counter in any row fails per counter with no row created", () => {
  const { db, personA, profileA } = setup("agentv2-g4p2-nocounter-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "p2nocounter", steps: STEPS });
  runPlanDryRun(db, planId, { activeMsPerStep: 100, limits: { activeTimeBudgetMs: 1000 } });
  runPlanDryRun(db, planId, { activeMsPerStep: 0, limits: { activeTimeBudgetMs: 1000 } });
  const noTime = { activeMs: null, waitMs: 0, llmCalls: 0, llmTokens: 0, costUsd: 0, planChanges: 0, noProgressRepetitions: 0, lastFingerprint: null, lastStepIndex: null };
  db.prepare("UPDATE plan_executions SET usage_json = ? WHERE plan_id = ?").run(JSON.stringify(noTime), planId);
  assert.throws(() => runPlanDryRun(db, planId, { limits: { activeTimeBudgetMs: 1000 }, initialUsage: {}, resetBudget: false }), /activeMs.*no earlier valid execution|no earlier valid execution/);
  assert.equal(listExecutions(db, planId).length, 2, "failed recovery must create no execution row");
});

test("P2: explicit resetBudget still produces a genuinely fresh start (regression)", () => {
  const { db, personA, profileA } = setup("agentv2-g4p2-reset-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "p2reset", steps: STEPS });
  runPlanDryRun(db, planId, { activeMsPerStep: 100, limits: { activeTimeBudgetMs: 1000 } });
  const execution = runPlanDryRun(db, planId, { activeMsPerStep: 0, limits: { activeTimeBudgetMs: 1000 }, resetBudget: true });
  assert.equal(execution.state, "observed_only");
  assert.ok(execution.usage.activeMs < 100, `reset must start fresh, got ${execution.usage.activeMs}`);
});

test("P2: valid finite per-step values still accumulate as before (regression)", () => {
  const { db, personA, profileA } = setup("agentv2-g4p2-finite-");
  const planId = createPlan(db, { personId: personA, offerId: "https://example.test/jobs/1", profileId: profileA, routeKind: "company_careers", rationale: "p2finite", steps: STEPS });
  const execution = runPlanDryRun(db, planId, { activeMsPerStep: 100, llmTokensPerStep: 5, llmCostPerStep: 0.5, limits: { activeTimeBudgetMs: 1000 } });
  assert.equal(execution.state, "observed_only");
  assert.ok(execution.usage.activeMs >= 100);
  assert.equal(execution.usage.llmTokens, 5);
  assert.equal(execution.usage.costUsd, 0.5);
  assert.equal(execution.usage.llmCalls, 1);
});
