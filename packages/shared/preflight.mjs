// F4 T-V2-040 (RF-V2-050, RF-V2-008): preflight revalidation and the
// per-offer auto-policy decision.
//
// Preflight revalidates language, validity, profile, mandatory
// fields, documents, policy, account and dedupe, and returns an
// explicit reason per unmet condition WITHOUT executing any final
// action. This module is pure: it writes nothing, creates no attempt,
// enqueues nothing and submits nothing. A "pass" means only "would
// be allowed" — the caller still needs a later phase to act.
//
// The hard rule, enforced in decideAuto and tested explicitly: a HIGH
// SCORE NEVER overrides an excluding criterion. Hard failures beat
// any score, always, in both manual preflight (eligible=false) and
// the auto decision (allowed=false).

import { canonicalId } from "./search-dedupe.mjs";

function condition(name, ok, reason) {
  return { condition: name, ok, reason: ok ? null : reason };
}

/**
 * Preflight check. Inputs are caller-supplied evidence, never
 * re-derived from a score:
 *  offer: {title, language, status, expired?}
 *  readiness: {ready, missing[]} from profileReadiness
 *  documents: {cvValidated: boolean}
 *  policy: {accepted: boolean} for manual mode; for auto mode see
 *    autoPolicy {enabled, valid, profileIds, sources} + autoSource
 *  account: {status: "confirmed"|"unconfirmed"|"unknown"}
 *  sentCanonicalIds / pendingCanonicalIds: canonical ids already sent/pending
 * @param {any} input
 * @returns {{pass: boolean, reasons: any[], failedConditions: string[]}}
 */

export function preflightCheck(input = {}) {
  const offer = input.offer ?? {};
  const readiness = input.readiness ?? { ready: false, missing: ["readiness_unknown"] };
  const mode = input.mode ?? "manual";
  const reasons = [];

  // Language: candidacy material is English only (pliego standing
  // rule). Unknown language blocks; non-English blocks.
  if (!offer.language || offer.language === "unknown") {
    reasons.push(condition("language", false, "offer language is unknown: cannot confirm English candidacy material"));
  } else if (String(offer.language).toLowerCase() !== "en") {
    reasons.push(condition("language", false, `offer language is ${offer.language}, not English`));
  } else {
    reasons.push(condition("language", true));
  }

  // Validity: a closed/expired offer blocks, whatever its score.
  if (offer.status === "closed" || offer.status === "expired" || offer.expired === true) {
    reasons.push(condition("validity", false, `offer is ${offer.status ?? "expired"}: no longer valid`));
  } else {
    reasons.push(condition("validity", true));
  }

  // Profile: readiness (identity, focus, facts, CV, policy, consent,
  // xAI) plus not-deleted.
  if (input.profileDeleted) {
    reasons.push(condition("profile", false, "profile is deleted"));
  } else if (!readiness.ready) {
    reasons.push(condition("profile", false, `profile is not ready: missing ${[...(readiness.missing ?? [])].join(", ") || "unknown"}`));
  } else {
    reasons.push(condition("profile", true));
  }

  // Mandatory fields: the readiness gaps that are fields (identity,
  // name, focus), reported separately from the profile verdict so a
  // caller can see WHICH field blocks.
  const fieldMissing = (readiness.missing ?? []).filter((m) => ["identity", "name", "focus"].includes(m));
  if (fieldMissing.length > 0) {
    reasons.push(condition("mandatory_fields", false, `mandatory fields missing: ${fieldMissing.join(", ")}`));
  } else if (!readiness.ready && (readiness.missing ?? []).length > 0) {
    reasons.push(condition("mandatory_fields", true));
  } else {
    reasons.push(condition("mandatory_fields", true));
  }

  // Documents: a validated CV explicitly selected for THIS profile.
  if (!input.documents?.cvValidated) {
    reasons.push(condition("documents", false, "no validated CV selected for this profile"));
  } else {
    reasons.push(condition("documents", true));
  }

  // Policy: manual mode needs the accepted policy/consent; auto mode
  // needs an enabled, valid auto policy covering this profile and source.
  if (mode === "auto") {
    const policy = input.autoPolicy ?? {};
    if (!policy.enabled) reasons.push(condition("policy", false, "automatic mode is not enabled"));
    else if (!policy.valid) reasons.push(condition("policy", false, "the auto-apply policy is incomplete or invalid"));
    else if (input.profileId && Array.isArray(policy.profileIds) && !policy.profileIds.includes(input.profileId)) {
      reasons.push(condition("policy", false, "this profile is not covered by the auto-apply policy"));
    } else if (input.autoSource && Array.isArray(policy.sources) && !policy.sources.includes(input.autoSource)) {
      reasons.push(condition("policy", false, "this source is not covered by the auto-apply policy"));
    } else reasons.push(condition("policy", true));
  } else if (!input.policy?.accepted) {
    reasons.push(condition("policy", false, "required policy/consent is not accepted"));
  } else {
    reasons.push(condition("policy", true));
  }

  // Account: only a confirmed account passes. Unknown is a block,
  // never an assumption.
  if (input.account?.status !== "confirmed") {
    reasons.push(condition("account", false, `account status is ${input.account?.status ?? "unknown"}: a confirmed account is required`));
  } else {
    reasons.push(condition("account", true));
  }

  // Dedupe: one attempt per person per offer; sent or pending blocks.
  let id = null;
  try {
    id = canonicalId(offer);
  } catch {
    id = null;
  }
  if (id && (input.sentCanonicalIds ?? []).includes(id)) {
    reasons.push(condition("dedupe", false, "this offer was already sent by this person (canonical identity)"));
  } else if (id && (input.pendingCanonicalIds ?? []).includes(id)) {
    reasons.push(condition("dedupe", false, "this offer has a pending equivalence: never auto-sendable"));
  } else {
    reasons.push(condition("dedupe", true));
  }

  const failed = reasons.filter((r) => !r.ok).map((r) => r.condition);
  return { pass: failed.length === 0, reasons, failedConditions: failed };
}

/**
 * Per-offer auto-policy decision. `hardFailed` is the filter engine's
 * hard-exclusion list (search-filters): any entry blocks, whatever
 * `score` is. `score` is reported but never consulted for eligibility.
 * This function creates nothing: allowed=true is a decision, not an
 * action, and auto-apply stays disabled until its own gate.
 * @param {any} input
 */
export function decideAuto(input = {}) {
  const hardFailed = input.hardFailed ?? [];
  const preflight = input.preflight ?? { pass: false, failedConditions: ["preflight_not_run"] };
  const reasons = [];
  if (!input.autoEnabled) reasons.push("automatic mode is disabled");
  if (hardFailed.length > 0) reasons.push(`excluding criterion holds: ${hardFailed.join(", ")} — a high score never overrides an exclusion`);
  if (!preflight.pass) reasons.push(`preflight failed: ${(preflight.failedConditions ?? []).join(", ")}`);
  return {
    allowed: reasons.length === 0,
    score: input.score ?? null,
    scoreDoesNotOverrideExclusion: true,
    hardFailed,
    preflightPass: preflight.pass,
    reasons,
    actionTaken: "none: this decision executes no final action",
  };
}
