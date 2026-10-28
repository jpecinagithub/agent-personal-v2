// F4 T-V2-038 (RF-V2-047, RF-V2-075): per-application limits,
// progress fingerprints, error classification and sanitised diagnosis.
//
// Rules enforced here, not left to callers:
//  - Active time EXCLUDES user-wait time: recordWait() never touches
//    activeMs, and the tracker reports both counters separately.
//  - Exhausting any limit produces an explained, recoverable
//    stuck/wait state — never a silent loop and never an unbounded
//    retry. check() lists every exhausted limit by name.
//  - Diagnosis never carries bodies, secret values or codes: the
//    sanitiser redacts secret-like assignments and long free text
//    before anything is stored or returned.

import { createHash } from "node:crypto";

export const DEFAULT_LIMITS = {
  activeTimeBudgetMs: 10 * 60 * 1000,
  maxLlmCalls: 20,
  maxLlmTokens: 50000,
  maxCostUsd: 2,
  maxPlanChanges: 3,
  maxNoProgressRepetitions: 3,
};

export const ERROR_KINDS = ["llm", "network", "rendering", "business", "mail", "unknown"];

/** Validate a limits object: every field must be a finite positive number. */
export function validateLimits(limits = {}) {
  const merged = { ...DEFAULT_LIMITS, ...(limits ?? {}) };
  const out = {};
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const v = merged[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`limit ${key} must be a positive finite number`);
    out[key] = v;
  }
  return out;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

/**
 * Progress fingerprint: a hash of the last observable state plus the
 * step index. Two observations with the same fingerprint at the same
 * step index are a repetition without progress, whatever their
 * timestamps or log verbosity say.
 * @param {any} observableState summary of observable state (never a body/secret)
 * @param {number} stepIndex
 */
export function progressFingerprint(observableState, stepIndex) {
  return createHash("sha256").update(stableStringify({ state: observableState ?? null, step: stepIndex })).digest("hex");
}

/** Fresh usage counters for a limits object. */
export function freshUsage() {
  return {
    activeMs: 0, waitMs: 0, llmCalls: 0, llmTokens: 0, costUsd: 0,
    planChanges: 0, noProgressRepetitions: 0, lastFingerprint: null, lastStepIndex: null,
  };
}

/**
 * Pure limit tracker: every mutation returns a new usage object and a
 * check result. `state` is "active" until a limit exhausts, then
 * "stuck" with recoverable=true and an explicit resume action.
 * @param {any} limits validated limits
 * @param {any} usage current usage (freshUsage() to start)
 */
export function checkLimits(limits, usage) {
  const exhausted = [];
  if (usage.activeMs >= limits.activeTimeBudgetMs) exhausted.push("active_time");
  if (usage.llmCalls >= limits.maxLlmCalls) exhausted.push("llm_calls");
  if (usage.llmTokens >= limits.maxLlmTokens) exhausted.push("llm_tokens");
  if (usage.costUsd >= limits.maxCostUsd) exhausted.push("llm_cost");
  if (usage.planChanges >= limits.maxPlanChanges) exhausted.push("plan_changes");
  if (usage.noProgressRepetitions >= limits.maxNoProgressRepetitions) exhausted.push("no_progress_repetitions");
  if (exhausted.length > 0) {
    return {
      state: "stuck", recoverable: true, exhausted,
      reason: `limit exhausted: ${exhausted.join(", ")} — execution paused for user review; resume only via a new plan version or an explicit user decision, never by retrying`,
      resumeAction: "user_review_or_new_plan_version",
    };
  }
  return { state: "active", recoverable: true, exhausted: [], reason: null, resumeAction: null };
}

/** Add active milliseconds (never call this for user-wait time). */
export function recordActiveMs(usage, ms) {
  if (typeof ms !== "number" || ms < 0) throw new Error("active ms must be a non-negative number");
  return { ...usage, activeMs: usage.activeMs + ms };
}

/** Add user-wait milliseconds: tracked for reporting, never counted as active time. */
export function recordWaitMs(usage, ms) {
  if (typeof ms !== "number" || ms < 0) throw new Error("wait ms must be a non-negative number");
  return { ...usage, waitMs: usage.waitMs + ms };
}

/** Record one LLM call with its token and cost accounting. */
export function recordLlmCall(usage, { tokens = 0, costUsd = 0 } = {}) {
  if (tokens < 0 || costUsd < 0) throw new Error("LLM tokens and cost must be non-negative");
  return { ...usage, llmCalls: usage.llmCalls + 1, llmTokens: usage.llmTokens + tokens, costUsd: usage.costUsd + costUsd };
}

/** Record one plan change (a new plan version). */
export function recordPlanChange(usage) {
  return { ...usage, planChanges: usage.planChanges + 1 };
}

/**
 * Record one step observation: when the fingerprint equals the
 * previous observation at the same step index, the no-progress
 * counter increments; any new fingerprint or step advance resets it.
 */
export function recordObservation(usage, observableState, stepIndex) {
  const fingerprint = progressFingerprint(observableState, stepIndex);
  const repeated = usage.lastFingerprint === fingerprint && usage.lastStepIndex === stepIndex;
  return {
    ...usage,
    lastFingerprint: fingerprint,
    lastStepIndex: stepIndex,
    noProgressRepetitions: repeated ? usage.noProgressRepetitions + 1 : 0,
    fingerprint,
    repeated,
  };
}

// --- Error classification + sanitised diagnosis (RF-V2-075) ----------------

const SECRET_ASSIGNMENT = /(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|bearer|otp|verification[_-]?code|session[_-]?id)\s*[:=]\s*[^\s,;]+/gi;
const LONG_CODE = /\b\d{6,}\b/g;

/** Strip secret-like assignments, long numeric codes and long bodies. */
export function sanitiseText(text) {
  let out = String(text ?? "");
  out = out.replace(SECRET_ASSIGNMENT, "$1=[redacted]");
  out = out.replace(LONG_CODE, "[redacted]");
  if (out.length > 200) out = `${out.slice(0, 200)}…[truncated]`;
  return out;
}

/**
 * Classify an error into one of llm/network/rendering/business/mail/
 * unknown, from its message and optional hints. The returned
 * diagnosis carries stage/field/page/effect signals only — never a
 * body, a secret value or a code.
 * @param {any} err Error or string
 * @param {{stage?: string, field?: string|null, page?: string|null, effect?: string|null}} [ctx]
 */
export function classifyError(err, ctx = {}) {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const hay = raw.toLowerCase();
  let kind = "unknown";
  if (/timeout|econnrefused|enotfound|network|fetch failed|socket hang up|http_5|http 5\d\d|429|rate limit/i.test(hay)) kind = "network";
  else if (/model|llm|xai|token|prompt|completion|context length/i.test(hay)) kind = "llm";
  else if (/selector|element|render|chromium|page crash|navigation|locator/i.test(hay)) kind = "rendering";
  else if (/smtp|imap|mail|email delivery|mailbox/i.test(hay)) kind = "mail";
  else if (/validation|policy|forbidden|unauthori[sz]ed|business|ineligible|excluded/i.test(hay)) kind = "business";
  return {
    kind,
    stage: ctx.stage ?? "unknown",
    field: ctx.field ?? null,
    page: ctx.page ?? null,
    effect: ctx.effect ?? null,
    message: sanitiseText(raw),
  };
}

/** Build a sanitised diagnosis record for one failed step. */
export function diagnoseStep({ stage, field = null, page = null, error, effect = null }) {
  const classified = classifyError(error, { stage, field, page, effect });
  return {
    stage: classified.stage,
    field: classified.field,
    control: field,
    errorKind: classified.kind,
    error: classified.message,
    page: classified.page,
    effectSignals: effect ? [effect] : [],
  };
}
