// F3 T-V2-034 (binding): ranking by profile view only, comparison
// across profiles, and the versioned search benchmark
// (tests/fixtures/search-benchmark.json, synthetic data only).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rankOffers, compareProfiles, scoreOffer, summarizeRun, RANK_WEIGHTS, RANK_TOTAL } from "../packages/shared/search-rank.mjs";
import { evaluateOffer } from "../packages/shared/search-filters.mjs";
import { dedupeOffers } from "../packages/shared/search-dedupe.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCHMARK = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures", "search-benchmark.json"), "utf8"));

const FINANCE_PROFILE = {
  profileId: "profile-finance",
  name: "Finance",
  fields: {
    desired_roles: ["Finance Manager", "FP&A Manager", "Financial Controller"],
    locations: ["ES", "IE", "NL", "Logroño", "Dublin", "Amsterdam"],
    skills: ["FP&A", "IFRS"],
    exclusions: ["Intern"],
    salary_expectations: { currency: "EUR", min: 50000, max: 80000, period: "year" },
  },
  presentedEmployment: [
    { id: "job-1", employer: "Acme Test Corp", title: "Finance Manager", start: "2020-01", end: "2025-12" },
    { id: "job-2", employer: "Globex Test Ltd", title: "FP&A Analyst", start: "2018-01", end: "2019-12" },
  ],
  presentedEducation: [
    { id: "edu-1", institution: "Fixture University", title: "BSc Finance", start: "2014", end: "2018" },
  ],
};

const BENCHMARK_CRITERIA = {
  countries: ["ES", "IE", "NL"],
  remoteCountries: ["ES"],
  workModes: ["remote", "hybrid", "onsite"],
  language: "en",
  salary: { min: 40000, currency: "EUR", period: "year", unknownPolicy: "review" },
  companies: { blocked: ["Blocked Test Corp"] },
  excludedSkills: ["COBOL"],
  excludedTitles: ["Intern"],
  sponsorship: { requires: true, unknownPolicy: "review" },
  authorisation: { unknownPolicy: "review" },
  sentCanonicalIds: [BENCHMARK.sentStrongKey],
};

const PROFILE_AUTHORISATIONS = { ES: "yes", IE: "yes", NL: "yes", US: "no", DE: "unknown" };

function profileWithAuthorisations(view) {
  return { ...view, authorisationByCountry: PROFILE_AUTHORISATIONS };
}

function offer(over = {}) {
  return {
    source: "greenhouse-catalog", ats: "greenhouse", tenant: "acme-test", postingId: "p-1",
    canonicalUrl: "https://example.test/jobs/p-1", applyUrl: "https://example.test/apply/p-1",
    title: "Finance Manager", company: "Acme Test Corp",
    location: { country: "ES", region: "La Rioja", city: "Logroño", raw: "Logroño", remote: false },
    workMode: "onsite", seniority: "senior", contractType: "permanent", workingTime: "full-time",
    sector: "finance", description: "Finance Manager with FP&A experience and IFRS knowledge.",
    skills: ["FP&A", "IFRS"], salary: { min: 50000, max: 70000, currency: "EUR", period: "year", published: true },
    language: "en", sponsorship: "yes", relocation: "no",
    publishedAt: "2026-10-20T00:00:00Z", firstSeenAt: "2026-10-21T00:00:00Z", evidence: {},
    ...over,
  };
}

test("rank: weights sum to 100, scores are integers, components carry evidence and unknown flags", () => {
  assert.equal(Object.values(RANK_WEIGHTS).reduce((a, b) => a + b, 0), 100);
  assert.equal(RANK_TOTAL, 100);
  const scored = scoreOffer(offer(), FINANCE_PROFILE, BENCHMARK_CRITERIA, { now: "2026-10-28T00:00:00Z" });
  assert.ok(scored);
  assert.ok(Number.isInteger(scored.total));
  assert.ok(scored.total <= 100);
  for (const [key, weight] of Object.entries(RANK_WEIGHTS)) {
    const c = scored.components[key];
    assert.ok(Number.isInteger(c.score), `${key} must be an integer`);
    assert.ok(c.score <= weight, `${key} must not exceed its weight`);
    assert.equal(typeof c.evidence, "string");
    assert.equal(typeof c.unknown, "boolean");
  }
  // Exact title match gives the full role weight.
  assert.equal(scored.components.roleSeniority.score, 30);
});

test("rank: unknowns are shown, never counted as matches", () => {
  const scored = scoreOffer(offer({ publishedAt: null, skills: [], description: "" }), FINANCE_PROFILE, BENCHMARK_CRITERIA, { now: "2026-10-28T00:00:00Z" });
  assert.ok(scored);
  assert.equal(scored.components.skills.unknown, true);
  assert.equal(scored.components.skills.score, 0);
  assert.equal(scored.components.preferencesRecency.unknown, true);
});

test("rank: hard-failed offers are excluded regardless of score", () => {
  const blocked = offer({ company: "Blocked Test Corp" });
  const { ranked, excluded } = rankOffers([offer(), blocked], FINANCE_PROFILE, BENCHMARK_CRITERIA, { now: "2026-10-28T00:00:00Z" });
  assert.equal(ranked.length, 1);
  assert.equal(excluded.length, 1);
  assert.ok(excluded[0].hardFailed.includes("companies"));
  assert.equal(scoreOffer(blocked, FINANCE_PROFILE, BENCHMARK_CRITERIA), null);
  // Even a perfect title match cannot rescue a hard failure.
  const spanish = offer({ language: "es", description: "Gerente de finanzas." });
  assert.equal(rankOffers([spanish], FINANCE_PROFILE, BENCHMARK_CRITERIA).ranked.length, 0);
});

test("rank: ranking sorts by total, best first", () => {
  const strong = offer();
  const weak = offer({ title: "Salesforce Administrator", description: "Salesforce administration.", skills: ["Salesforce"] });
  const { ranked } = rankOffers([weak, strong], FINANCE_PROFILE, BENCHMARK_CRITERIA, { now: "2026-10-28T00:00:00Z" });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].offer.title, "Finance Manager");
  assert.ok(ranked[0].total > ranked[1].total);
});

// ------------------------------------------------------------ Benchmark

test("benchmark: fixture is versioned, synthetic, and has at least 60 offers", () => {
  assert.equal(BENCHMARK.version, 1);
  assert.ok(BENCHMARK.offers.length >= 60, `expected >= 60 offers, got ${BENCHMARK.offers.length}`);
  for (const o of BENCHMARK.offers) {
    assert.ok(o.expected, `offer ${o.id} lacks an expected annotation`);
    assert.equal(typeof o.expected.excluded, "boolean");
    assert.ok(!JSON.stringify(o).includes("jpecina"), "benchmark must not contain personal data");
  }
});

test("benchmark: zero false passes on annotated hard exclusions", () => {
  let falsePasses = 0;
  let checked = 0;
  for (const o of BENCHMARK.offers) {
    if (!o.expected.excluded) continue;
    checked += 1;
    const verdict = evaluateOffer(o, BENCHMARK_CRITERIA, profileWithAuthorisations(FINANCE_PROFILE));
    if (verdict.eligible) {
      falsePasses += 1;
      console.error(`FALSE PASS: ${o.id} (${o.expected.category}) should be excluded but was eligible`);
    }
  }
  assert.ok(checked >= 20, `expected >= 20 annotated exclusions, got ${checked}`);
  assert.equal(falsePasses, 0);
});

test("benchmark: non-excluded offers are not hard-failed, and critical unknowns need review, never auto-apply", () => {
  for (const o of BENCHMARK.offers) {
    if (o.expected.excluded) continue;
    const verdict = evaluateOffer(o, BENCHMARK_CRITERIA, profileWithAuthorisations(FINANCE_PROFILE));
    assert.equal(verdict.eligible, true, `offer ${o.id} (${o.expected.category}) should be eligible`);
    if (o.expected.category === "unknown-salary" || o.expected.category === "sponsorship-unknown"
      || o.expected.category === "remote-unknown-country") {
      assert.equal(verdict.needsReview, true, `${o.id} should need review`);
      assert.equal(verdict.canAutoApply, false, `${o.id} must never auto-apply`);
    }
  }
});

test("benchmark: dedupe — strong duplicates collapse, weak groups stay for review, distinct postings stay distinct", () => {
  const { unique, duplicates, uncertainGroups } = dedupeOffers(BENCHMARK.offers);
  const annotatedDups = BENCHMARK.offers.filter((o) => o.expected.duplicateStrongOf);
  assert.equal(duplicates.length, annotatedDups.length, `expected ${annotatedDups.length} strong duplicates`);
  for (const d of duplicates) {
    const original = BENCHMARK.offers.find((o) => o.id === d.offer.expected.duplicateStrongOf);
    assert.ok(original, `duplicate ${d.offer.id} points at an unknown original`);
    assert.ok(d.provenance.length >= 2);
  }
  assert.equal(unique.length, BENCHMARK.offers.length - duplicates.length);
  // Same title, different locations: all three stay unique and share no weak group.
  const sameTitle = BENCHMARK.offers.filter((o) => o.expected.category === "same-title-different-location");
  assert.equal(sameTitle.length, 3);
  for (const o of sameTitle) assert.ok(unique.includes(o), `${o.id} must stay unique`);
  // Annotated uncertain pairs: both members stay unique and share a weak group.
  for (const group of ["uncertain-0", "uncertain-1"]) {
    const members = BENCHMARK.offers.filter((o) => o.expected.uncertainGroup === group);
    assert.equal(members.length, 2);
    for (const m of members) assert.ok(unique.includes(m), `${m.id} must stay unique (review grouping only)`);
    const found = uncertainGroups.find((g) => g.offers.includes(members[0]) && g.offers.includes(members[1]));
    assert.ok(found, `uncertain group ${group} not found`);
  }
});

test("benchmark: unknown dates are marked unknown in ranking, never assumed recent", () => {
  const unknownDate = BENCHMARK.offers.filter((o) => o.expected.category === "unknown-date");
  assert.equal(unknownDate.length, 2);
  const { ranked } = rankOffers(unknownDate, FINANCE_PROFILE, BENCHMARK_CRITERIA, { now: "2026-10-28T00:00:00Z" });
  assert.equal(ranked.length, 2);
  for (const r of ranked) {
    assert.equal(r.components.preferencesRecency.unknown, true);
    assert.ok(r.components.preferencesRecency.score <= 7, "recency points must not be counted for an unknown date");
  }
});

test("rank: two profiles over the same person, with different fields and selections, rank and compare differently", () => {
  // Same master history; the profiles present DIFFERENT selections
  // and fields. The ranker receives only the profile views — there
  // is no person-history parameter to leak across profiles.
  const financeView = {
    profileId: "profile-finance",
    name: "Finance",
    fields: {
      desired_roles: ["Finance Manager", "FP&A Manager"],
      locations: ["ES", "Logroño"],
      skills: ["FP&A", "IFRS"],
      exclusions: [],
      salary_expectations: { currency: "EUR", min: 50000, max: 80000, period: "year" },
    },
    presentedEmployment: [
      { id: "job-1", employer: "Acme Test Corp", title: "Finance Manager", start: "2020-01", end: "2025-12" },
    ],
    presentedEducation: [],
  };
  const techView = {
    profileId: "profile-tech",
    name: "Tech",
    fields: {
      desired_roles: ["Salesforce Administrator"],
      locations: ["IE", "Dublin"],
      skills: ["Salesforce"],
      exclusions: [],
      salary_expectations: { currency: "EUR", min: 40000, max: 60000, period: "year" },
    },
    presentedEmployment: [
      { id: "job-2", employer: "Globex Test Ltd", title: "Salesforce Administrator", start: "2021-01", end: "2025-12" },
    ],
    presentedEducation: [],
  };
  const financeOffer = offer();
  const salesforceOffer = offer({
    title: "Salesforce Administrator", description: "Salesforce administration and CRM configuration.",
    skills: ["Salesforce"], postingId: "p-2",
    canonicalUrl: "https://example.test/jobs/p-2", applyUrl: "https://example.test/apply/p-2",
  });
  const offers = [financeOffer, salesforceOffer];
  const financeRanked = rankOffers(offers, financeView, {}, { now: "2026-10-28T00:00:00Z" });
  const techRanked = rankOffers(offers, techView, {}, { now: "2026-10-28T00:00:00Z" });
  assert.equal(financeRanked.ranked[0].offer.title, "Finance Manager");
  assert.equal(techRanked.ranked[0].offer.title, "Salesforce Administrator");
  // The same offer scores differently under each profile.
  const financeScore = financeRanked.ranked.find((r) => r.offer.title === "Finance Manager").total;
  const techScore = techRanked.ranked.find((r) => r.offer.title === "Finance Manager").total;
  assert.notEqual(financeScore, techScore);
  // compareProfiles recommends a different best profile per offer.
  const compared = compareProfiles(offers, [financeView, techView], {}, { now: "2026-10-28T00:00:00Z" });
  const byTitle = Object.fromEntries(compared.results.map((r) => [r.offer.title, r.bestProfileId]));
  assert.equal(byTitle["Finance Manager"], "profile-finance");
  assert.equal(byTitle["Salesforce Administrator"], "profile-tech");
  // No application is created by comparison: results carry scores only.
  for (const r of compared.results) {
    assert.equal(r.scores.length, 2);
    assert.ok(r.scores.every((s) => typeof s.total === "number" || s.total === null));
  }
});

test("rank: summarizeRun reports numerators and denominators, partial vs complete coverage, never a universality percentage", () => {
  const summary = summarizeRun([
    { source: "greenhouse-catalog", status: "completed", observed: 10, valid: 8, duplicates: 1, excluded: 1, pending: 0 },
    { source: "lever-catalog", status: "rate_limited", cause: "429 from upstream" },
    { source: "ashby-catalog", status: "completed_zero_results", observed: 0, valid: 0, duplicates: 0, excluded: 0, pending: 0 },
  ], ["greenhouse-catalog", "lever-catalog", "ashby-catalog"]);
  assert.equal(summary.attempted, 3);
  assert.equal(summary.completed, 2);
  assert.equal(summary.observed, 10);
  assert.equal(summary.valid, 8);
  assert.equal(summary.duplicates, 1);
  assert.equal(summary.excluded, 1);
  assert.equal(summary.coverage, "partial");
  assert.equal(summary.causes.length, 1);
  assert.equal(summary.causes[0].source, "lever-catalog");
  assert.ok(!("percentage" in summary) && !("percent" in summary) && !("coveragePercent" in summary));
  const complete = summarizeRun(
    [{ source: "greenhouse-catalog", status: "completed", observed: 5, valid: 5, duplicates: 0, excluded: 0, pending: 0 }],
    ["greenhouse-catalog"],
  );
  assert.equal(complete.coverage, "complete");
});
