// F4 end-to-end flow (G4 acceptance): inspection → assessment →
// plan → observable execution → preflight, as ONE traceable flow
// sharing a single traceId — not isolated modules.
//
// Traceability: the traceId is stored on the plan and on every
// execution of that plan, and returned with every stage, so one
// inspected offer can be followed through assessment, plan and
// execution without re-deriving the linkage.
//
// Safety invariants of this flow (each is asserted by tests):
//  - Untrusted page text is scanned and rejected instructions are
//    recorded, but the page text is NEVER used as a fact and NEVER
//    changes the target offer: the offer passed in is the offer
//    assessed, whatever the page instructs.
//  - Missing mandatory facts produce QUESTIONS (fact_questions rows
//    via askMissingFact), never inferred facts and never a score raise.
//  - Preflight "pass" means only "would be allowed". This flow
//    creates NO attempt, NO queue job and NO final action (no
//    submission, no send): the final counts are returned and must be
//    zero for attempts/queue jobs created by the flow.

import { randomUUID } from "node:crypto";
import { analyseRoute } from "./route-classify.mjs";
import { scanAndRecord } from "./untrusted.mjs";
import { compareOfferProfiles, recordComparison, questionsForAssessment } from "./requirements.mjs";
import { askMissingFact } from "./chat-tools.mjs";
import { createPlan, runPlanDryRun } from "./application-plan.mjs";
import { assertProfileBelongsToPerson } from "./profiles.mjs";
import { preflightCheck, decideAuto } from "./preflight.mjs";

/**
 * Run the full F4 flow. All inputs are caller-supplied; `offer` is
 * the offer under assessment (a stored offer object or an extraction
 * result normalised by the caller into offer shape).
 * @param {any} db
 * @param {any} input
 * @param {{observeFn?: any, limits?: any, activeMsPerStep?: number, llmTokensPerStep?: number, llmCostPerStep?: number, initialUsage?: any}} [opts]
 */
export function runF4Flow(db, input, opts = {}) {
  const {
    personId, offer, profileViews, chosenProfileId = null,
    extraction = null, url = null, pageText = null, applyUrl = null,
    redirectChain = [], planSteps, planDocuments = [], planRationale,
    preflightInput = {},
  } = input ?? {};
  if (!personId || !offer) throw new Error("personId and offer are required");
  if (!Array.isArray(profileViews) || profileViews.length === 0) throw new Error("profileViews must be a non-empty array");
  if (!Array.isArray(planSteps) || planSteps.length === 0) throw new Error("planSteps must be a non-empty array");
  // Ownership FIRST, before any persistence (including the untrusted
  // scan records below): no view of another person's profile may
  // enter this person's flow.
  for (const view of profileViews) {
    assertProfileBelongsToPerson(db, personId, view.profileId);
  }
  const traceId = randomUUID();

  const attemptsBefore = db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE person_id = ?").get(personId).n;
  const jobsBefore = db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n;

  // Stage 1 — inspection. Untrusted page text is scanned first; any
  // rejected instruction is recorded with its source and changes
  // nothing: the offer, the route and the plan below keep using the
  // caller's offer and URL, never the page's instructions.
  let untrustedScan = { rejected: false, findings: [], recordedIds: [] };
  if (typeof pageText === "string" && pageText) {
    untrustedScan = scanAndRecord(db, { sourceKind: "page", sourceRef: url ?? offer.canonicalUrl ?? null, text: pageText });
  }
  const inspection = analyseRoute({
    extraction: extraction ?? { status: "ok", url: url ?? offer.canonicalUrl ?? null, title: offer.title ?? null, description: offer.description ?? "", language: offer.language ?? "unknown", languageMethod: "caller-supplied", evidence: {} },
    url: url ?? offer.canonicalUrl ?? null,
    applyUrl: applyUrl ?? offer.applyUrl ?? null,
    redirectChain,
    pageText,
  });

  // Stage 2 — assessment + multi-profile comparison.
  const comparison = compareOfferProfiles(offer, profileViews, { criteria: input.criteria ?? {}, factsByProfile: input.factsByProfile ?? {} });
  const chosen = chosenProfileId ?? comparison.bestProfileId;
  let comparisonId = null;
  if (chosen) {
    comparisonId = recordComparison(db, {
      personId, offerId: input.offerId ?? offer.canonicalUrl ?? offer.title ?? "offer",
      chosenProfileId: chosen,
      assessments: comparison.assessments,
    });
  }

  // Stage 3 — questions for unknown requirements of the chosen
  // profile's assessment. No fact is stored; gaps stay open.
  const chosenAssessment = comparison.assessments.find((a) => a.profileId === chosen) ?? null;
  const questions = [];
  if (chosenAssessment) {
    for (const q of questionsForAssessment(chosenAssessment)) {
      const asked = askMissingFact(db, personId, q);
      questions.push({ ...q, reused: asked.reused, kind: asked.kind, questionId: asked.question?.id ?? null });
    }
  }

  if (!chosen) throw new Error("no eligible profile for this offer: the flow cannot fix a profile or create a plan");
  // Stage 4 — versioned plan, profile fixed to the chosen profile.
  const planId = createPlan(db, {
    personId,
    offerId: input.offerId ?? offer.canonicalUrl ?? offer.title ?? "offer",
    profileId: chosen,
    routeKind: inspection.route.route,
    ats: inspection.ats.ats,
    tenant: inspection.ats.tenant,
    rationale: planRationale ?? `Route ${inspection.route.route} chosen: ${inspection.route.evidence.join("; ") || "no route signal, offered as assisted"}. ATS: ${inspection.ats.ats} (${inspection.ats.engine}).`,
    steps: planSteps,
    documents: planDocuments,
    contingencies: input.planContingencies ?? [],
    traceId,
  });

  // Stage 5 — observable dry-run execution (no filling, no submission).
  const execution = runPlanDryRun(db, planId, {
    limits: opts.limits,
    observeFn: opts.observeFn,
    activeMsPerStep: opts.activeMsPerStep ?? 0,
    llmTokensPerStep: opts.llmTokensPerStep ?? 0,
    llmCostPerStep: opts.llmCostPerStep ?? 0,
    initialUsage: opts.initialUsage,
  });

  // Stage 6 — preflight + auto decision. Both are decisions only.
  const preflight = preflightCheck({
    offer, readiness: preflightInput.readiness ?? { ready: false, missing: ["readiness_not_supplied"] },
    documents: preflightInput.documents ?? { cvValidated: false },
    policy: preflightInput.policy ?? { accepted: false },
    account: preflightInput.account ?? { status: "unknown" },
    mode: preflightInput.mode ?? "manual",
    autoPolicy: preflightInput.autoPolicy,
    profileId: chosen,
    profileDeleted: preflightInput.profileDeleted ?? false,
    sentCanonicalIds: preflightInput.sentCanonicalIds ?? [],
    pendingCanonicalIds: preflightInput.pendingCanonicalIds ?? [],
  });
  const autoDecision = decideAuto({
    score: chosenAssessment?.rank?.total ?? null,
    hardFailed: preflightInput.hardFailed ?? [],
    preflight,
    autoEnabled: preflightInput.autoEnabled ?? false,
  });

  const attemptsAfter = db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE person_id = ?").get(personId).n;
  const jobsAfter = db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n;

  return {
    traceId,
    inspection,
    untrustedScan: { rejected: untrustedScan.rejected, findings: untrustedScan.findings, recordedIds: untrustedScan.recordedIds },
    comparison,
    chosenProfileId: chosen,
    comparisonId,
    questions,
    planId,
    execution,
    preflight,
    autoDecision,
    counts: {
      attemptsBefore, attemptsAfter, attemptsCreatedByFlow: attemptsAfter - attemptsBefore,
      jobsBefore, jobsAfter, jobsCreatedByFlow: jobsAfter - jobsBefore,
      finalActions: 0,
    },
  };
}
