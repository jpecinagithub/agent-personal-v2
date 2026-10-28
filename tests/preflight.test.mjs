// F4 T-V2-040 (RF-V2-050, RF-V2-008): preflight revalidation and
// the per-offer auto-policy decision. A high score never overrides
// an excluding criterion, and a preflight "pass" executes nothing.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { preflightCheck, decideAuto } from "../packages/shared/preflight.mjs";

function baseInput(overrides = {}) {
  return {
    offer: { title: "Finance Manager", language: "en", canonicalUrl: "https://example.test/jobs/1", status: "open" },
    readiness: { ready: true, missing: [] },
    documents: { cvValidated: true },
    policy: { accepted: true },
    account: { status: "confirmed" },
    mode: "manual",
    sentCanonicalIds: [],
    pendingCanonicalIds: [],
    ...overrides,
  };
}

test("T-V2-040: preflight passes only when every condition holds, and names the failing condition", () => {
  const passing = preflightCheck(baseInput());
  assert.equal(passing.pass, true);
  assert.deepEqual(passing.failedConditions, []);
  const cases = /** @type {Array<[any, string]>} */ ([
    [{ offer: { title: "Finance Manager", language: "es", canonicalUrl: "https://example.test/jobs/1" } }, "language"],
    [{ offer: { title: "Finance Manager", language: "unknown", canonicalUrl: "https://example.test/jobs/1" } }, "language"],
    [{ offer: { title: "Finance Manager", language: "en", canonicalUrl: "https://example.test/jobs/1", status: "closed" } }, "validity"],
    [{ readiness: { ready: false, missing: ["identity", "focus"] } }, "profile"],
    [{ readiness: { ready: false, missing: ["identity"] } }, "mandatory_fields"],
    [{ documents: { cvValidated: false } }, "documents"],
    [{ policy: { accepted: false } }, "policy"],
    [{ account: { status: "unknown" } }, "account"],
    [{ account: { status: "unconfirmed" } }, "account"],
  ]);
  for (const [override, condition] of cases) {
    const result = preflightCheck(baseInput(override));
    assert.equal(result.pass, false, condition);
    assert.ok(result.failedConditions.includes(condition), `${condition} should be reported, got ${result.failedConditions.join(",")}`);
    const reason = result.reasons.find((r) => r.condition === condition);
    assert.ok(reason && reason.reason && reason.reason.length > 0, `${condition} needs an explicit reason`);
  }
});

test("T-V2-040: dedupe blocks sent and pending offers; auto mode needs an enabled policy covering profile and source", () => {
  const sent = preflightCheck(baseInput({ sentCanonicalIds: ["url:https://example.test/jobs/1"] }));
  assert.ok(sent.failedConditions.includes("dedupe"));
  const pending = preflightCheck(baseInput({ pendingCanonicalIds: ["url:https://example.test/jobs/1"] }));
  assert.ok(pending.failedConditions.includes("dedupe"));
  const autoDisabled = preflightCheck(baseInput({
    mode: "auto", autoPolicy: { enabled: false, valid: true, profileIds: ["p1"], sources: ["greenhouse"] },
    profileId: "p1", autoSource: "greenhouse",
  }));
  assert.ok(autoDisabled.failedConditions.includes("policy"));
  const autoWrongProfile = preflightCheck(baseInput({
    mode: "auto", autoPolicy: { enabled: true, valid: true, profileIds: ["p2"], sources: ["greenhouse"] },
    profileId: "p1", autoSource: "greenhouse",
  }));
  assert.ok(autoWrongProfile.failedConditions.includes("policy"));
  const autoOk = preflightCheck(baseInput({
    mode: "auto", autoPolicy: { enabled: true, valid: true, profileIds: ["p1"], sources: ["greenhouse"] },
    profileId: "p1", autoSource: "greenhouse",
  }));
  assert.equal(autoOk.pass, true);
});

test("T-V2-040: a HIGH SCORE NEVER overrides an excluding criterion — in preflight or in the auto decision", () => {
  // Even with score 100, a hard exclusion denies auto.
  const denied = decideAuto({
    score: 100, hardFailed: ["language"], preflight: { pass: true, failedConditions: [] }, autoEnabled: true,
  });
  assert.equal(denied.allowed, false);
  assert.ok(denied.reasons.join(" ").includes("excluding criterion"));
  assert.equal(denied.score, 100, "the score is reported, not hidden — it just does not decide");
  assert.equal(denied.scoreDoesNotOverrideExclusion, true);
  // A failed preflight also denies, whatever the score.
  const deniedPreflight = decideAuto({
    score: 100, hardFailed: [], preflight: { pass: false, failedConditions: ["account"] }, autoEnabled: true,
  });
  assert.equal(deniedPreflight.allowed, false);
  // Disabled auto denies even with a perfect preflight and score.
  const deniedDisabled = decideAuto({
    score: 100, hardFailed: [], preflight: { pass: true, failedConditions: [] }, autoEnabled: false,
  });
  assert.equal(deniedDisabled.allowed, false);
  // The only allowed case: enabled + clean preflight + no hard fail.
  const allowed = decideAuto({
    score: 82, hardFailed: [], preflight: { pass: true, failedConditions: [] }, autoEnabled: true,
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.actionTaken, "none: this decision executes no final action");
});

test("T-V2-040: preflight and the auto decision are pure — they create no attempt, no queue job, no final action", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-preflight-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const preflight = preflightCheck(baseInput());
  const decision = decideAuto({ score: 95, hardFailed: [], preflight, autoEnabled: false });
  assert.equal(preflight.pass, true);
  assert.equal(decision.allowed, false, "auto stays disabled");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
});
