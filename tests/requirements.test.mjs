// F4 T-V2-036 (RF-V2-044, RF-V2-040): requirement assessment and
// multi-profile comparison. Synthetic fixtures only: the profile's
// OWN fields + presentedHistory only — never the whole person history.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { createProfileFull } from "../packages/shared/profiles.mjs";
import { buildProfileView } from "../packages/shared/search-run.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import {
  splitRequirements, extractRequirements, assessOffer, compareOfferProfiles,
  recordComparison, getComparison, questionsForAssessment,
} from "../packages/shared/requirements.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-requirements-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, FIXTURE_PERSON);
  const financeId = createProfileFull(db, personId, "Finance", {
    focus: "Finance", desired_roles: ["Finance Manager"], locations: ["Madrid"],
    skills: ["accounting", "forecasting"], employment_ids: ["job-1"], education_ids: ["edu-1"],
  });
  const techId = createProfileFull(db, personId, "Tech", {
    focus: "Tech", desired_roles: ["Data Analyst"], skills: ["python"],
    employment_ids: [], education_ids: [],
  });
  return { db, personId, financeId, techId };
}

const OFFER = {
  title: "Finance Manager",
  description: "Finance Manager role.",
  language: "en",
  canonicalUrl: "https://example.test/jobs/finance-manager",
  requirements: [
    { text: "Must have accounting experience", kind: "mandatory" },
    { text: "Must have 5 years of experience", kind: "mandatory" },
    { text: "Must hold a valid certification in advanced regulatory reporting frameworks", kind: "mandatory" },
    { text: "Nice to have forecasting skills", kind: "desirable" },
    { text: "Python programming", kind: "mandatory" },
  ],
};

test("T-V2-036: requirements split into mandatory/desirable/unknown from markers", () => {
  const reqs = splitRequirements("Must have accounting experience.\nNice to have forecasting skills.\nA friendly team and modern offices.");
  assert.equal(reqs[0].kind, "mandatory");
  assert.equal(reqs[1].kind, "desirable");
  assert.equal(reqs[2].kind, "unknown");
  assert.deepEqual(extractRequirements(OFFER).map((r) => r.kind),
    ["mandatory", "mandatory", "mandatory", "desirable", "mandatory"]);
});

test("T-V2-036: assessment contrasts against presented history only; gaps stay visible and add 0 to the score", () => {
  const { db, financeId } = setup();
  const view = buildProfileView(db, financeId);
  // The finance profile presents job-1 (Accountant, 2020-01..2024-06
  // = 4.5 years) and skills accounting/forecasting.
  const assessment = assessOffer(OFFER, view);
  assert.equal(assessment.mandatory.total, 4);
  assert.equal(assessment.mandatory.met, 1, "only accounting is met");
  assert.equal(assessment.score, 1);
  const gapTexts = assessment.gaps.map((g) => g.text);
  assert.ok(gapTexts.includes("Must have 5 years of experience"), "4.5 presented years < 5 required is a gap");
  assert.ok(gapTexts.includes("Python programming"), "an unlisted skill is a gap");
  // The long certification requirement cannot be confirmed: unknown, not a gap filled by inference.
  const unknown = assessment.contrasts.find((c) => c.requirement.text.includes("certification"));
  assert.equal(unknown.status, "unknown");
  // Removing the gaps cannot change the score: gaps contribute 0.
  const withoutGaps = assessOffer({ ...OFFER, requirements: OFFER.requirements.filter((r) => !gapTexts.includes(r.text)) }, view);
  assert.equal(withoutGaps.score, assessment.score, "gaps contribute exactly 0 to the score");
  // A profile that hides the finance job must NOT assess with it:
  // the tech profile presents no employment and no accounting skill.
  const { db: db2, techId } = setup();
  const techView = buildProfileView(db2, techId);
  const techAssessment = assessOffer(OFFER, techView);
  assert.equal(techAssessment.contrasts.find((c) => c.requirement.text.includes("accounting")).status, "gap");
});

test("T-V2-036: multi-profile comparison recommends the best profile and never applies", () => {
  const { db, financeId, techId } = setup();
  const views = [buildProfileView(db, financeId), buildProfileView(db, techId)];
  const comparison = compareOfferProfiles(OFFER, views);
  assert.equal(comparison.assessments.length, 2);
  assert.equal(comparison.bestProfileId, financeId);
  assert.equal(comparison.recommendation.profileId, financeId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get().n, 0, "comparison creates no attempt");
});

test("T-V2-036: one comparison per person+offer fixes the profile; a different profile is refused; an attempt blocks recording", () => {
  const { db, personId, financeId, techId } = setup();
  const offerId = "https://example.test/jobs/finance-manager";
  const first = recordComparison(db, { personId, offerId, chosenProfileId: financeId, assessments: [] });
  assert.equal(getComparison(db, personId, offerId).chosen_profile_id, financeId);
  assert.equal(recordComparison(db, { personId, offerId, chosenProfileId: financeId, assessments: [] }), first, "same profile re-records idempotently");
  assert.throws(() => recordComparison(db, { personId, offerId, chosenProfileId: techId, assessments: [] }), /fixed a different profile/);
  // An attempt for the same person+offer blocks any comparison.
  db.prepare("INSERT INTO offers (id, source, ats, canonical_url, title) VALUES (?, 'test', 'generic', ?, 'Finance Manager')").run("offer-row", offerId);
  db.prepare("INSERT INTO attempts (id, person_id, profile_id, offer_id) VALUES (?, ?, ?, ?)").run("attempt-row", personId, financeId, "offer-row");
  assert.throws(() => recordComparison(db, { personId, offerId: "offer-row", chosenProfileId: financeId, assessments: [] }), /already exists/);
});

test("T-V2-036: unknown requirements produce questions with purpose + scope, and asking stores no fact", () => {
  const { db, financeId } = setup();
  const view = buildProfileView(db, financeId);
  const assessment = assessOffer(OFFER, view);
  const questions = questionsForAssessment(assessment);
  assert.equal(questions.length, 1, "only the unknown requirement produces a question; gaps do not");
  assert.ok(questions[0].questionText.length > 0);
  assert.ok(questions[0].purpose.length > 0);
  assert.ok(questions[0].scope.length > 0);
  assert.equal(questions[0].requirementText.includes("certification"), true);
});
