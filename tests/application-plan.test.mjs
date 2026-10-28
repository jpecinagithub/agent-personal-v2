// F4 T-V2-037 (RF-V2-045, RF-V2-046) + G4 real enforcement:
// versioned plans, the observable dry-run executor, structured
// adaptation, enforced pre/postconditions and enforced limits.
// Synthetic fixtures only. No test here fills a form, submits
// anything or creates an attempt.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { createProfileFull } from "../packages/shared/profiles.mjs";
import { listFacts } from "../packages/shared/facts.mjs";
import { listConsents } from "../packages/shared/policies.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import {
  createPlan, getPlan, createPlanVersion, listPlanVersions,
  proposeAdaptation, listAdaptations, runPlanDryRun, getExecution,
} from "../packages/shared/application-plan.mjs";
import { recordComparison } from "../packages/shared/requirements.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-plan-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, FIXTURE_PERSON);
  const profileId = createProfileFull(db, personId, "Finance", { focus: "Finance" });
  return { db, personId, profileId };
}

const STEPS = [
  { id: "step-1", title: "Observe the offer page", kind: "observe_page", observableInput: "offer page", observableOutput: "title and form visible" },
  { id: "step-2", title: "Check the form fields", kind: "check_field", dependsOn: ["step-1"], observableInput: "form", observableOutput: "fields listed" },
  { id: "step-3", title: "Fill the form", kind: "fill_form", dependsOn: ["step-2"], observableInput: "form", observableOutput: "form filled" },
];

/** @param {any} steps */
function makePlan(db, personId, profileId, steps = STEPS) {
  return createPlan(db, {
    personId, offerId: "https://example.test/jobs/1", profileId,
    routeKind: "direct_form", ats: "unknown",
    rationale: "Direct form visible on the employer's page.",
    steps, documents: [{ kind: "cv" }],
    contingencies: [{ when: "form changes", then: "stop and ask the user" }],
    traceId: "trace-test-1",
  });
}

test("T-V2-037: plan v1 stores steps, profile, documents, contingencies and rationale; versions are append-only", () => {
  const { db, personId, profileId } = setup();
  const planId = makePlan(db, personId, profileId);
  const plan = getPlan(db, planId);
  assert.equal(plan.version, 1);
  assert.equal(plan.profile_id, profileId);
  assert.equal(plan.trace_id, "trace-test-1");
  assert.equal(plan.steps.length, 3);
  assert.equal(plan.documents[0].kind, "cv");
  assert.equal(plan.rationale.includes("Direct form"), true);
  assert.equal(listPlanVersions(db, planId).length, 1);
  const v2 = createPlanVersion(db, planId, { reason: "user review: drop the fill step from observation", steps: STEPS.slice(0, 2) });
  assert.equal(v2, 2);
  assert.equal(getPlan(db, planId).version, 2);
  assert.equal(getPlan(db, planId).profile_id, profileId, "a new version never changes the profile");
  assert.equal(listPlanVersions(db, planId).length, 2);
  assert.equal(listPlanVersions(db, planId)[0].steps.length, 3, "version 1 is immutable");
  assert.throws(() => createPlanVersion(db, planId, { steps: STEPS.slice(0, 2) }), /needs a reason/);
  assert.throws(() => createPlanVersion(db, planId, { reason: "x", steps: [{ id: "a", title: "Loop", kind: "observe_page", dependsOn: ["a"] }] }), /cycle|unknown step/);
  assert.throws(() => createPlan(db, { personId, offerId: "https://example.test/jobs/2", profileId, routeKind: "direct_form", rationale: "", steps: STEPS }), /rationale is required/);
  assert.throws(() => createPlan(db, { personId, offerId: "https://example.test/jobs/2", profileId, routeKind: "direct_form", rationale: "ok", steps: STEPS, documents: [{ kind: "cv", content: "generated text" }] }), /never generated content/);
});

test("T-V2-037: a plan's profile must be the comparison's chosen profile", () => {
  const { db, personId, profileId } = setup();
  const otherId = createProfileFull(db, personId, "Tech", { focus: "Tech" });
  recordComparison(db, { personId, offerId: "https://example.test/jobs/1", chosenProfileId: profileId, assessments: [] });
  assert.throws(() => makePlan(db, personId, otherId), /chosen profile/);
  assert.doesNotThrow(() => makePlan(db, personId, profileId));
});

test("T-V2-037: dry-run observes, defers fill/submit steps, creates no attempt and changes no policy or fact", () => {
  const { db, personId, profileId } = setup();
  const factsBefore = listFacts(db, personId).length;
  const consentsBefore = listConsents(db, personId).length;
  const planId = makePlan(db, personId, profileId);
  const execution = runPlanDryRun(db, planId, { observeFn: (step) => step.observableInput });
  assert.equal(execution.state, "observed_only");
  assert.equal(execution.traceId, "trace-test-1");
  assert.deepEqual(execution.stepResults.map((s) => s.status), ["observed", "observed", "deferred_to_later_phase"]);
  assert.equal(getExecution(db, execution.executionId).state, "observed_only");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get().n, 0, "dry-run creates no attempt");
  assert.equal(listFacts(db, personId).length, factsBefore, "executor changes no fact");
  assert.equal(listConsents(db, personId).length, consentsBefore, "executor changes no policy/consent");
});

test("T-V2-037: adaptations are recorded, never applied; a policy-changing adaptation is REFUSED and the policy is unchanged", () => {
  const { db, personId, profileId } = setup();
  const planId = makePlan(db, personId, profileId);
  const stepsBefore = JSON.stringify(getPlan(db, planId).steps);
  const adaptationId = proposeAdaptation(db, { planId, reason: "form gained a field", changes: { steps: "add a check step" } });
  const adaptation = db.prepare("SELECT * FROM plan_adaptations WHERE id = ?").get(adaptationId);
  assert.equal(adaptation.status, "proposed");
  assert.equal(JSON.stringify(getPlan(db, planId).steps), stepsBefore, "a proposal never applies itself");
  // Policy violation, flagged explicitly.
  const refusedId = proposeAdaptation(db, { planId, reason: "enable auto-apply to speed up", changes: {}, policyViolation: "would enable automatic mode without a valid auto-apply policy" });
  const refused = db.prepare("SELECT * FROM plan_adaptations WHERE id = ?").get(refusedId);
  assert.equal(refused.status, "refused");
  assert.ok(String(refused.refusal_reason).includes("automatic mode"));
  // Policy violation, detected from the changes themselves.
  const autoModeBefore = db.prepare("SELECT value_json FROM settings WHERE key = 'auto_mode'").get();
  const refused2Id = proposeAdaptation(db, { planId, reason: "adjust policy", changes: { policy: { auto_mode: "on" } } });
  assert.equal(db.prepare("SELECT * FROM plan_adaptations WHERE id = ?").get(refused2Id).status, "refused");
  assert.deepEqual(db.prepare("SELECT value_json FROM settings WHERE key = 'auto_mode'").get(), autoModeBefore, "the refused adaptation changed no policy setting");
  assert.equal(listAdaptations(db, planId).length, 3);
});

test("G4 enforcement: a failed precondition BLOCKS execution — no step executes", () => {
  const { db, personId, profileId } = setup();
  const planId = makePlan(db, personId, profileId, [
    { id: "step-1", title: "Check account", kind: "check_account", observableInput: "account page", preconditions: ["step:never-observed:observed"] },
    { id: "step-2", title: "Observe page", kind: "observe_page", dependsOn: ["step-1"], observableInput: "page" },
  ]);
  const execution = runPlanDryRun(db, planId);
  assert.equal(execution.state, "blocked");
  assert.equal(execution.stepResults.filter((s) => s.status === "observed").length, 0, "no step executed");
  assert.equal(execution.stepResults[0].status, "blocked_precondition");
  assert.ok(execution.stoppedReason.includes("precondition failed"));
});

test("G4 enforcement: a failed postcondition is REPORTED as failed and the run does not claim success", () => {
  const { db, personId, profileId } = setup();
  const planId = makePlan(db, personId, profileId, [
    { id: "step-1", title: "Observe page", kind: "observe_page", observableInput: "page loaded", postconditions: ["confirmation visible"] },
    { id: "step-2", title: "Check fields", kind: "check_field", dependsOn: ["step-1"], observableInput: "form" },
  ]);
  const execution = runPlanDryRun(db, planId);
  assert.equal(execution.state, "failed");
  assert.equal(execution.stepResults[0].status, "failed_postcondition");
  assert.ok(execution.stepResults[0].effect.includes("postcondition failed"));
  assert.equal(execution.stepResults.length, 1, "the run stops at the failed step");
  // And a satisfied postcondition passes.
  const planId2 = makePlan(db, personId, profileId, [
    { id: "step-1", title: "Observe page", kind: "observe_page", observableInput: "page loaded: confirmation visible", postconditions: ["confirmation visible"] },
  ]);
  // A second plan for the same offer+person is allowed (plans are not attempts).
  const execution2 = runPlanDryRun(db, planId2);
  assert.equal(execution2.state, "observed_only");
  assert.equal(execution2.stepResults[0].status, "observed");
});

test("G4 enforcement: exceeding a limit STOPS the run with a recorded stuck state and does not continue steps", () => {
  const { db, personId, profileId } = setup();
  const manySteps = Array.from({ length: 5 }, (_, i) => ({
    id: `step-${i + 1}`, title: `Observe ${i + 1}`, kind: "observe_page",
    observableInput: `page ${i + 1}`, dependsOn: i > 0 ? [`step-${i}`] : [],
  }));
  const planId = makePlan(db, personId, profileId, manySteps);
  const execution = runPlanDryRun(db, planId, { activeMsPerStep: 1000, limits: { activeTimeBudgetMs: 1500 } });
  assert.equal(execution.state, "stuck");
  assert.ok(execution.stoppedReason.includes("active_time"));
  assert.equal(execution.stepResults.filter((s) => s.status === "observed").length, 1, "only the first step observed before the budget exhausted");
  assert.equal(execution.stepResults.at(-1).status, "stuck");
  assert.equal(getExecution(db, execution.executionId).state, "stuck", "the stuck state is recorded");
  // Cost exhaustion stops the same way.
  const planId2 = makePlan(db, personId, profileId, manySteps);
  const costExecution = runPlanDryRun(db, planId2, { llmCostPerStep: 1, limits: { maxCostUsd: 1.5 } });
  assert.equal(costExecution.state, "stuck");
  assert.ok(costExecution.stoppedReason.includes("llm_cost"));
  assert.equal(costExecution.stepResults.filter((s) => s.status === "observed").length, 1);
});
