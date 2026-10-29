// F4 T-V2-037 (RF-V2-045, RF-V2-046): versioned application plans
// and the observable executor.
//
// What this phase does NOT do, by construction:
//  - No browser form filling, no submission, no attempt creation.
//    The executor's "act" is DRY-RUN / observation only: it records
//    what was observed for each step and marks fill/submit steps as
//    deferred to a later phase. Filling and submission belong to
//    later phases (F7/F9); a plan step whose kind is fill/submit can
//    be PLANNED here but never EXECUTED here.
//  - The executor NEVER changes policies or facts itself. Adaptation
//    proposals are recorded (plan_adaptations, status "proposed") and
//    never applied: applying one means creating a new plan version
//    through createPlanVersion, and policy/fact changes must go
//    through their own APIs with their own validation.
//  - A plan's profile is fixed at creation (RF-V2-040): versions may
//    change steps, documents, rationale or contingencies, never the
//    profile, person or offer.

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { assertNoAttempt, getComparison } from "./requirements.mjs";
import { assertProfileBelongsToPerson } from "./profiles.mjs";
import { validateLimits, freshUsage, checkLimits, recordObservation, recordPlanChange, recordLlmCall, recordActiveMs } from "./limits.mjs";

export const OBSERVATION_STEP_KINDS = ["observe_page", "check_field", "review_document", "wait_user", "check_account", "verify_preflight"];
export const DEFERRED_STEP_KINDS = ["fill_form", "submit", "upload_document", "send_email"];
export const ALL_STEP_KINDS = [...OBSERVATION_STEP_KINDS, ...DEFERRED_STEP_KINDS];

function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("plan steps must be a non-empty array");
  const ids = new Set();
  for (const step of steps) {
    if (!step || typeof step.title !== "string" || !step.title.trim()) throw new Error("each plan step needs a title");
    if (!ALL_STEP_KINDS.includes(step.kind)) throw new Error(`unknown plan step kind: ${step.kind}`);
    if (step.id !== undefined) {
      if (ids.has(step.id)) throw new Error(`duplicate plan step id: ${step.id}`);
      ids.add(step.id);
    }
    for (const dep of step.dependsOn ?? []) {
      if (typeof dep !== "string") throw new Error("step dependsOn entries must be step ids");
    }
  }
  // Dependencies must reference a step in the plan (checked after
  // ids are collected, including auto-assigned ids).
  const allIds = new Set(steps.map((s, i) => s.id ?? `step-${i + 1}`));
  for (const step of steps) {
    for (const dep of step.dependsOn ?? []) {
      if (!allIds.has(dep)) throw new Error(`plan step depends on unknown step: ${dep}`);
    }
  }
  // Cycle check (Kahn).
  const indegree = new Map([...allIds].map((id) => [id, 0]));
  const outgoing = new Map([...allIds].map((id) => [id, []]));
  steps.forEach((step, i) => {
    const id = step.id ?? `step-${i + 1}`;
    for (const dep of step.dependsOn ?? []) { outgoing.get(dep).push(id); indegree.set(id, indegree.get(id) + 1); }
  });
  const queue = [...allIds].filter((id) => indegree.get(id) === 0);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    visited += 1;
    for (const next of outgoing.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (visited !== allIds.size) throw new Error("plan steps contain a dependency cycle");
  return steps.map((step, i) => ({
    id: step.id ?? `step-${i + 1}`,
    title: step.title.trim(),
    kind: step.kind,
    dependsOn: step.dependsOn ?? [],
    observableInput: step.observableInput ?? null,
    observableOutput: step.observableOutput ?? null,
    preconditions: step.preconditions ?? [],
    postconditions: step.postconditions ?? [],
    contingency: step.contingency ?? null,
  }));
}

function validateDocuments(documents) {
  if (documents === undefined) return [];
  if (!Array.isArray(documents)) throw new Error("plan documents must be an array");
  for (const d of documents) {
    if (!d || typeof d.kind !== "string" || !d.kind.trim()) throw new Error("each planned document needs a kind");
    // Planned documents are KINDS (cv, cover_letter), never generated
    // content: a document entry must not carry generated text.
    if (d.content !== undefined) throw new Error("planned documents carry kinds only, never generated content (document generation is a later phase)");
  }
  return documents.map((d) => ({ kind: d.kind, status: d.status ?? "planned", note: d.note ?? null }));
}

/** @param {any} db */
export function getPlan(db, planId) {
  const row = db.prepare("SELECT * FROM application_plans WHERE id = ?").get(planId);
  if (!row) return null;
  return {
    ...row,
    steps: JSON.parse(row.steps_json),
    documents: JSON.parse(row.documents_json),
    contingencies: JSON.parse(row.contingencies_json),
  };
}

/** @param {any} db */
export function listPlans(db, opts = {}) {
  const { personId, offerId } = opts;
  let sql = "SELECT * FROM application_plans";
  const params = [];
  const where = [];
  if (personId) { where.push("person_id = ?"); params.push(personId); }
  if (offerId) { where.push("offer_id = ?"); params.push(offerId); }
  if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
  sql += " ORDER BY created_at ASC";
  return db.prepare(sql).all(...params).map((row) => ({
    ...row, steps: JSON.parse(row.steps_json), documents: JSON.parse(row.documents_json), contingencies: JSON.parse(row.contingencies_json),
  }));
}

/**
 * Create a version-1 plan. Requires: the person+offer has no attempt
 * yet, and when a comparison was recorded for this person+offer, the
 * plan's profile must be the comparison's chosen profile.
 * @param {any} db
 */
export function createPlan(db, input = {}) {
  const { personId, offerId, profileId, routeKind, ats = "unknown", tenant = null, rationale, steps, documents = undefined, contingencies = [], traceId = null } = input;
  if (!personId || !offerId || !profileId) throw new Error("personId, offerId and profileId are required");
  if (!routeKind) throw new Error("routeKind is required");
  if (typeof rationale !== "string" || !rationale.trim()) throw new Error("plan rationale is required: the user must see why this route was chosen");
  assertProfileBelongsToPerson(db, personId, profileId);
  assertNoAttempt(db, personId, offerId);
  const comparison = getComparison(db, personId, offerId);
  if (comparison && comparison.chosen_profile_id !== profileId) {
    throw new Error("plan profile must be the comparison's chosen profile: the profile is fixed before document generation");
  }
  const validSteps = validateSteps(steps);
  const validDocs = validateDocuments(documents);
  if (!Array.isArray(contingencies)) throw new Error("plan contingencies must be an array");
  const id = randomUUID();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO application_plans (id, person_id, offer_id, profile_id, route_kind, ats, tenant, version, rationale, steps_json, documents_json, contingencies_json, status, trace_id) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'draft', ?)").run(
      id, personId, offerId, profileId, routeKind, ats, tenant, rationale.trim(),
      JSON.stringify(validSteps), JSON.stringify(validDocs), JSON.stringify(contingencies), traceId,
    );
    db.prepare("INSERT INTO plan_versions (id, plan_id, version, steps_json, documents_json, rationale, reason) VALUES (?, ?, 1, ?, ?, ?, 'initial version')").run(
      randomUUID(), id, JSON.stringify(validSteps), JSON.stringify(validDocs), rationale.trim(),
    );
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
  return id;
}

/**
 * Create a new plan version. Profile/person/offer/route are immutable:
 * only steps, documents, contingencies and rationale may change, and
 * every change carries its reason. Returns the new version number.
 * @param {any} db
 */
export function createPlanVersion(db, planId, input = {}) {
  const { steps = undefined, documents = undefined, contingencies = undefined, rationale = undefined, reason } = input;
  const plan = getPlan(db, planId);
  if (!plan) throw new Error("plan not found");
  if (typeof reason !== "string" || !reason.trim()) throw new Error("a new plan version needs a reason");
  const validSteps = steps !== undefined ? validateSteps(steps) : plan.steps;
  const validDocs = documents !== undefined ? validateDocuments(documents) : plan.documents;
  const validCont = contingencies !== undefined ? contingencies : plan.contingencies;
  const validRationale = rationale !== undefined ? rationale : plan.rationale;
  if (typeof validRationale !== "string" || !validRationale.trim()) throw new Error("plan rationale is required");
  const version = plan.version + 1;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE application_plans SET version = ?, steps_json = ?, documents_json = ?, contingencies_json = ?, rationale = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
      version, JSON.stringify(validSteps), JSON.stringify(validDocs), JSON.stringify(validCont), validRationale.trim(), planId,
    );
    db.prepare("INSERT INTO plan_versions (id, plan_id, version, steps_json, documents_json, rationale, reason) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      randomUUID(), planId, version, JSON.stringify(validSteps), JSON.stringify(validDocs), validRationale.trim(), reason.trim(),
    );
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
  return version;
}

/** @param {any} db */
export function listPlanVersions(db, planId) {
  return db.prepare("SELECT * FROM plan_versions WHERE plan_id = ? ORDER BY version ASC").all(planId).map((row) => ({
    ...row, steps: JSON.parse(row.steps_json), documents: JSON.parse(row.documents_json),
  }));
}

const FORBIDDEN_ADAPTATION_KEYS = ["policy", "policies", "fact", "facts", "setPolicy", "declareFact", "consent", "autoPolicy", "auto_policy"];

/**
 * Record an adaptation PROPOSAL. It is never applied by this function:
 * the plan is untouched, and no policy or fact row is written. Applying
 * a proposal is a separate, explicit createPlanVersion call (for plan
 * changes) or a call to the policy/fact APIs (for policy/fact changes).
 *
 * REFUSAL (real enforcement, not recording): an adaptation whose
 * changes would touch policies or facts, or whose caller flags a
 * policy violation, is recorded with status "refused" and a reason,
 * and the policy/fact state is left exactly as it was. A refused
 * adaptation changes nothing.
 * @param {any} db
 */
export function proposeAdaptation(db, input = {}) {
  const { planId, executionId = null, reason, changes = undefined, policyViolation = null } = input;
  if (typeof reason !== "string" || !reason.trim()) throw new Error("an adaptation proposal needs a reason");
  const plan = getPlan(db, planId);
  if (!plan) throw new Error("plan not found");
  // An adaptation may only reference an execution of THIS plan: an
  // execution of another plan must never be attached here.
  if (executionId !== null && executionId !== undefined) {
    const execution = db.prepare("SELECT * FROM plan_executions WHERE id = ?").get(executionId);
    if (!execution) throw new Error("execution not found");
    if (execution.plan_id !== planId) throw new Error("execution does not belong to this plan");
  }
  const changesObj = changes ?? {};
  const forbidden = Object.keys(changesObj).filter((k) => FORBIDDEN_ADAPTATION_KEYS.includes(k));
  const refusalReason = policyViolation
    ? String(policyViolation)
    : forbidden.length > 0
      ? `adaptation refused: it would change ${forbidden.join(", ")}, which the executor may never do by itself; use the policy/fact APIs with their own validation instead`
      : null;
  const id = randomUUID();
  db.prepare("INSERT INTO plan_adaptations (id, plan_id, execution_id, reason, changes_json, status, refusal_reason) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id, planId, executionId, reason.trim(), JSON.stringify(changesObj),
    refusalReason ? "refused" : "proposed", refusalReason,
  );
  return id;
}

/** @param {any} db */
export function listAdaptations(db, planId) {
  return db.prepare("SELECT * FROM plan_adaptations WHERE plan_id = ? ORDER BY created_at ASC").all(planId).map((row) => ({
    ...row, changes: JSON.parse(row.changes_json),
  }));
}

// --- Precondition / postcondition enforcement ------------------------------
// Preconditions are evaluated against the step results recorded SO FAR
// in this execution. Supported shapes:
//   - "step:<id>:observed" or {type: "step_observed", stepId}
//   - any other shape is UNKNOWN and therefore FAILS (blocks rather
//     than passing on an uninterpreted condition).
// Postconditions are evaluated against the step's OBSERVED value:
//   - a string, or {type: "observed_contains", value}: the JSON of the
//     observed value must contain it;
//   - {type: "observed_field", field, equals}: observed[field] must equal;
//   - {type: "observed_not_null"}: observed must not be null.
// A failed precondition BLOCKS the step and stops the run (no step
// executes past it); a failed postcondition marks the step FAILED and
// the run does not claim success. Neither is ever silently passed.

/** @param {any[]} preconditions @param {any[]} completedResults */
export function evaluatePreconditions(preconditions, completedResults) {
  const failed = [];
  for (const pre of preconditions ?? []) {
    let ok = false;
    let label = "";
    if (typeof pre === "string" && pre.startsWith("step:") && pre.endsWith(":observed")) {
      const stepId = pre.slice(5, -":observed".length);
      label = pre;
      ok = completedResults.some((r) => r.stepId === stepId && r.status === "observed");
    } else if (pre && pre.type === "step_observed" && typeof pre.stepId === "string") {
      label = `step:${pre.stepId}:observed`;
      ok = completedResults.some((r) => r.stepId === pre.stepId && r.status === "observed");
    } else {
      label = typeof pre === "string" ? pre : JSON.stringify(pre);
    }
    if (!ok) failed.push(label);
  }
  return { ok: failed.length === 0, failed };
}

/** @param {any[]} postconditions @param {any} observed */
export function evaluatePostconditions(postconditions, observed) {
  const failed = [];
  const observedJson = JSON.stringify(observed ?? null);
  for (const post of postconditions ?? []) {
    let ok = false;
    let label = "";
    if (typeof post === "string") {
      label = post;
      ok = observedJson.includes(post);
    } else if (post && post.type === "observed_contains" && typeof post.value === "string") {
      label = `observed contains ${post.value}`;
      ok = observedJson.includes(post.value);
    } else if (post && post.type === "observed_field" && typeof post.field === "string") {
      label = `observed.${post.field} equals ${JSON.stringify(post.equals)}`;
      ok = observed !== null && typeof observed === "object" && JSON.stringify(observed[post.field]) === JSON.stringify(post.equals);
    } else if (post && post.type === "observed_not_null") {
      label = "observed is not null";
      ok = observed !== null && observed !== undefined;
    } else {
      label = typeof post === "string" ? post : JSON.stringify(post);
    }
    if (!ok) failed.push(label);
  }
  return { ok: failed.length === 0, failed };
}

// --- Observable executor (dry-run / observation only) -----------------------

/** Order steps topologically (dependencies first). Steps are already validated acyclic. */
export function orderSteps(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const visited = new Set();
  const out = [];
  const visit = (step) => {
    if (visited.has(step.id)) return;
    visited.add(step.id);
    for (const dep of step.dependsOn ?? []) {
      const depStep = byId.get(dep);
      if (depStep) visit(depStep);
    }
    out.push(step);
  };
  for (const step of steps) visit(step);
  return out;
}

/**
 * Run a plan in dry-run mode. For each step, in dependency order:
 * observe (via observeFn, default: echo the step's observableInput) →
 * decide (the step itself is the next action) → validate (kind must
 * be an observation kind; fill/submit kinds are deferred, never
 * acted on) → act (record the observation only) → check effect
 * (postconditions are NOT claimed satisfied in dry-run; the result
 * records "observed_only") → persist (execution row + step results).
 * No browser, no form filling, no submission, no attempt, no policy
 * or fact write happens anywhere in this function.
 * @param {any} db
 * @param {string} planId
 * @param {{limits?: any, observeFn?: (step: any, index: number) => any, activeMsPerStep?: number, llmTokensPerStep?: number, llmCostPerStep?: number, initialUsage?: any}} [opts]
 */
export function runPlanDryRun(db, planId, opts = {}) {
  const plan = getPlan(db, planId);
  if (!plan) throw new Error("plan not found");
  const limits = validateLimits(opts.limits);
  let usage = { ...freshUsage(), ...(opts.initialUsage ?? {}) };
  const ordered = orderSteps(plan.steps);
  const stepResults = [];
  let state = "observed_only";
  let stoppedReason = null;
  for (let index = 0; index < ordered.length; index += 1) {
    const step = ordered[index];
    // Validate tool/policy BEFORE acting: deferred kinds are never acted on.
    if (DEFERRED_STEP_KINDS.includes(step.kind)) {
      stepResults.push({
        stepId: step.id, kind: step.kind, status: "deferred_to_later_phase",
        observed: null, effect: "not executed: filling/submission belongs to a later phase",
      });
      continue;
    }
    // Preconditions are ENFORCED: a failed precondition blocks this
    // step and stops the run — no step executes past it.
    const pre = evaluatePreconditions(step.preconditions, stepResults);
    if (!pre.ok) {
      stepResults.push({
        stepId: step.id, kind: step.kind, status: "blocked_precondition",
        observed: null, effect: `precondition failed: ${pre.failed.join(", ")} — step blocked, run stopped`,
        failedPreconditions: pre.failed,
      });
      state = "blocked";
      stoppedReason = `precondition failed at step ${step.id}: ${pre.failed.join(", ")}`;
      break;
    }
    // Observe, measuring REAL elapsed time around the observation
    // with a monotonic clock. The caller-supplied activeMsPerStep is
    // only a floor for additionally declared consumption: it can
    // never reduce the measured value, so claiming 0 ms cannot
    // defeat the budget (a 1 ms budget with a real ~57 ms
    // observation exhausts it). Genuine user-wait time is never
    // inside this measurement: only the executor's own observation
    // work is timed.
    let observed = null;
    const observeStarted = performance.now();
    const declaredMs = typeof opts.activeMsPerStep === "number" && opts.activeMsPerStep > 0 ? opts.activeMsPerStep : 0;
    try {
      observed = opts.observeFn ? opts.observeFn(step, index) : (step.observableInput ?? null);
    } catch (err) {
      // A failed observation still consumed REAL time: record it
      // before leaving (finally-style), or failures and their
      // retries would evade the accumulated time budget. The error
      // diagnosis is preserved unchanged below.
      const measuredMs = performance.now() - observeStarted;
      usage = recordActiveMs(usage, Math.max(measuredMs, declaredMs));
      stepResults.push({ stepId: step.id, kind: step.kind, status: "observation_failed", observed: null, effect: err instanceof Error ? err.message : String(err) });
      state = "stuck";
      stoppedReason = `observation failed at step ${step.id}`;
      break;
    }
    const measuredMs = performance.now() - observeStarted;
    // Decide: the step is the next action (no model re-planning here).
    // Check progress: a repeated fingerprint at the same index with
    // no advance is a repetition without progress.
    usage = recordObservation(usage, observed, index);
    usage = recordActiveMs(usage, Math.max(measuredMs, declaredMs));
    if ((opts.llmTokensPerStep ?? 0) > 0 || (opts.llmCostPerStep ?? 0) > 0) {
      usage = recordLlmCall(usage, { tokens: opts.llmTokensPerStep ?? 0, costUsd: opts.llmCostPerStep ?? 0 });
    }
    const check = checkLimits(limits, usage);
    if (check.state === "stuck") {
      stepResults.push({
        stepId: step.id, kind: step.kind, status: "stuck", observed: null,
        effect: check.reason, fingerprint: usage.lastFingerprint,
      });
      state = "stuck";
      stoppedReason = check.reason;
      break;
    }
    // Postconditions are ENFORCED: a failed postcondition marks the
    // step FAILED and the run does not claim success.
    const post = evaluatePostconditions(step.postconditions, observed);
    if (!post.ok) {
      stepResults.push({
        stepId: step.id, kind: step.kind, status: "failed_postcondition",
        observed: observed ?? null,
        effect: `postcondition failed: ${post.failed.join(", ")} — step failed, run stopped without claiming success`,
        failedPostconditions: post.failed,
      });
      state = "failed";
      stoppedReason = `postcondition failed at step ${step.id}: ${post.failed.join(", ")}`;
      break;
    }
    stepResults.push({
      stepId: step.id, kind: step.kind, status: "observed",
      observed: observed ?? null,
      effect: "observed_only: postconditions checked and satisfied in dry-run",
      fingerprint: usage.lastFingerprint,
      repeatedWithoutProgress: usage.noProgressRepetitions > 0,
    });
  }
  const executionId = randomUUID();
  db.prepare("INSERT INTO plan_executions (id, plan_id, plan_version, status, limits_json, usage_json, step_results_json, state, trace_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    executionId, planId, plan.version, state, JSON.stringify(limits), JSON.stringify(usage), JSON.stringify(stepResults), state, plan.trace_id ?? null,
  );
  db.prepare("UPDATE application_plans SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(state, planId);
  return { executionId, planId, planVersion: plan.version, traceId: plan.trace_id ?? null, state, stoppedReason, stepResults, usage, limits };
}

/** @param {any} db */
export function getExecution(db, executionId) {
  const row = db.prepare("SELECT * FROM plan_executions WHERE id = ?").get(executionId);
  if (!row) return null;
  return {
    ...row,
    limits: JSON.parse(row.limits_json),
    usage: JSON.parse(row.usage_json),
    stepResults: JSON.parse(row.step_results_json),
  };
}

/** @param {any} db */
export function listExecutions(db, planId) {
  return db.prepare("SELECT * FROM plan_executions WHERE plan_id = ? ORDER BY created_at ASC").all(planId).map((row) => ({
    ...row, limits: JSON.parse(row.limits_json), usage: JSON.parse(row.usage_json), stepResults: JSON.parse(row.step_results_json),
  }));
}

/** Apply a recorded plan-change to an execution's usage (used by tests/callers that version a plan mid-run). */
export function usageAfterPlanChange(usage) {
  return recordPlanChange(usage);
}
