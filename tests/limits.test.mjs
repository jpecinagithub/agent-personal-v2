// F4 T-V2-038 (RF-V2-047, RF-V2-075): limits, progress fingerprints,
// error classification and sanitised diagnosis. No network, no LLM.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateLimits, DEFAULT_LIMITS, freshUsage, checkLimits,
  recordActiveMs, recordWaitMs, recordLlmCall, recordObservation,
  recordPlanChange, progressFingerprint, classifyError, diagnoseStep, sanitiseText,
} from "../packages/shared/limits.mjs";

test("T-V2-038: limits validate; defaults are finite and positive", () => {
  assert.equal(validateLimits({}).activeTimeBudgetMs, DEFAULT_LIMITS.activeTimeBudgetMs);
  assert.throws(() => validateLimits({ maxLlmCalls: 0 }), /maxLlmCalls/);
  assert.throws(() => validateLimits({ maxCostUsd: -1 }), /maxCostUsd/);
  assert.throws(() => validateLimits({ activeTimeBudgetMs: Number.NaN }), /activeTimeBudgetMs/);
});

test("T-V2-038: a progress fingerprint detects repetitions without progress", () => {
  const a = progressFingerprint({ page: "form", fields: 3 }, 2);
  const b = progressFingerprint({ page: "form", fields: 3 }, 2);
  const c = progressFingerprint({ page: "form", fields: 4 }, 2);
  const d = progressFingerprint({ page: "form", fields: 3 }, 3);
  assert.equal(a, b, "same state + step = same fingerprint");
  assert.notEqual(a, c, "changed state = new fingerprint");
  assert.notEqual(a, d, "advanced step = new fingerprint");
  let usage = freshUsage();
  usage = recordObservation(usage, { page: "form" }, 1);
  assert.equal(usage.noProgressRepetitions, 0);
  usage = recordObservation(usage, { page: "form" }, 1);
  assert.equal(usage.noProgressRepetitions, 1);
  usage = recordObservation(usage, { page: "form" }, 1);
  usage = recordObservation(usage, { page: "form" }, 1);
  assert.equal(usage.noProgressRepetitions, 3);
  assert.deepEqual(checkLimits(validateLimits({ maxNoProgressRepetitions: 3 }), usage).exhausted, ["no_progress_repetitions"]);
  usage = recordObservation(usage, { page: "form", fields: 1 }, 1);
  assert.equal(usage.noProgressRepetitions, 0, "new observable state resets the counter");
});

test("T-V2-038: user-wait time never consumes active time; active time, calls, tokens and cost exhaust to an explained stuck state", () => {
  const limits = validateLimits({});
  let usage = freshUsage();
  usage = recordWaitMs(usage, 60 * 60 * 1000);
  assert.equal(usage.activeMs, 0, "an hour of waiting is not active time");
  assert.equal(checkLimits(limits, usage).state, "active");
  usage = recordActiveMs(usage, limits.activeTimeBudgetMs);
  assert.deepEqual(checkLimits(limits, usage).exhausted, ["active_time"]);
  assert.equal(checkLimits(limits, usage).state, "stuck");
  assert.equal(checkLimits(limits, usage).recoverable, true);
  assert.ok(checkLimits(limits, usage).reason.includes("user review"));
  let costUsage = freshUsage();
  costUsage = recordLlmCall(costUsage, { tokens: 100, costUsd: 1 });
  costUsage = recordLlmCall(costUsage, { tokens: 100, costUsd: 1.5 });
  assert.deepEqual(checkLimits(validateLimits({ maxCostUsd: 2 }), costUsage).exhausted, ["llm_cost"]);
  const planUsage = recordPlanChange(recordPlanChange(recordPlanChange(freshUsage())));
  assert.deepEqual(checkLimits(validateLimits({ maxPlanChanges: 3 }), planUsage).exhausted, ["plan_changes"]);
});

test("T-V2-075: errors classify into llm/network/rendering/business/mail; diagnosis never carries bodies, secrets or codes", () => {
  assert.equal(classifyError(new Error("fetch failed: ECONNREFUSED")).kind, "network");
  assert.equal(classifyError(new Error("xAI model context length exceeded")).kind, "llm");
  assert.equal(classifyError(new Error("selector not found: element detached")).kind, "rendering");
  assert.equal(classifyError(new Error("SMTP mailbox unavailable")).kind, "mail");
  assert.equal(classifyError(new Error("policy validation failed")).kind, "business");
  const secretMessage = "request failed with api_key=sk-secret-value-123 and code 482913 plus a long body " + "x".repeat(500);
  const diagnosis = diagnoseStep({ stage: "submit", field: "email", page: "https://example.test/apply", error: new Error(secretMessage), effect: "no submission sent" });
  assert.ok(!diagnosis.error.includes("sk-secret-value-123"), "secret value redacted");
  assert.ok(!diagnosis.error.includes("482913"), "numeric code redacted");
  assert.ok(diagnosis.error.length <= 220, "long bodies truncated");
  assert.equal(diagnosis.stage, "submit");
  assert.equal(diagnosis.field, "email");
  assert.equal(diagnosis.errorKind, "unknown");
  assert.deepEqual(diagnosis.effectSignals, ["no submission sent"]);
  assert.ok(!sanitiseText("password=hunter2 token=abc").includes("hunter2"));
});
