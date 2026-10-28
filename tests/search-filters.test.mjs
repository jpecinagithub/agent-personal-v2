// F3 T-V2-024: filter engine, remote geo-restriction, salary
// comparability, tri-state unknowns, hard exclusions.
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateOffer } from "../packages/shared/search-filters.mjs";

function offer(over = {}) {
  return {
    source: "greenhouse-catalog", ats: "greenhouse", tenant: "acme", postingId: "p-1",
    canonicalUrl: "https://example.test/jobs/p-1", applyUrl: "https://example.test/apply/p-1",
    title: "Finance Manager", company: "Acme Test Corp",
    location: { country: "ES", region: "La Rioja", city: "Logroño", raw: "Logroño, Spain", remote: false },
    workMode: "onsite", seniority: "senior", contractType: "permanent", workingTime: "full-time",
    sector: "finance", description: "Finance Manager with FP&A experience and IFRS knowledge.",
    skills: ["FP&A", "IFRS"], salary: { min: 50000, max: 70000, currency: "EUR", period: "year", published: true },
    language: "en", sponsorship: "yes", relocation: "no",
    publishedAt: "2026-10-20T00:00:00Z", firstSeenAt: "2026-10-21T00:00:00Z", evidence: {},
    ...over,
  };
}

test("filters: a matching offer passes and can auto-apply", () => {
  const r = evaluateOffer(offer(), { countries: ["ES"], language: "en" });
  assert.equal(r.eligible, true);
  assert.equal(r.needsReview, false);
  assert.equal(r.canAutoApply, true);
  assert.equal(r.perCriterion.countries.status, "pass");
  assert.equal(r.perCriterion.language.status, "pass");
});

test("filters: remote is allowed ONLY from a listed remote country; unknown country is unknown, never worldwide", () => {
  const remote = (country) => offer({
    workMode: "remote",
    location: { country, region: "", city: "", raw: "Remote", remote: true },
  });
  const criteria = { remoteCountries: ["ES"] };
  assert.equal(evaluateOffer(remote("ES"), criteria).perCriterion.remoteCountries.status, "pass");
  assert.equal(evaluateOffer(remote("US"), criteria).perCriterion.remoteCountries.status, "fail");
  const unknown = evaluateOffer(remote(null), criteria);
  assert.equal(unknown.perCriterion.remoteCountries.status, "unknown");
  assert.equal(unknown.canAutoApply, false);
  assert.equal(unknown.needsReview, true);
  // A non-remote offer does not get a remote verdict.
  assert.equal(evaluateOffer(offer(), criteria).perCriterion.remoteCountries.status, "not_applicable");
});

test("filters: salary compares ONLY with same currency AND period; unpublished follows unknownPolicy", () => {
  const eur = { salary: { min: 40000, currency: "EUR", period: "year", unknownPolicy: "review" } };
  assert.equal(evaluateOffer(offer(), eur).perCriterion.salary.status, "pass");
  assert.equal(evaluateOffer(offer({ salary: { min: 80000, max: 90000, currency: "EUR", period: "year", published: true } }), { salary: { min: 40000, max: 60000, currency: "EUR", period: "year", unknownPolicy: "review" } }).perCriterion.salary.status, "fail");
  // Different currency: unknown, not a pass and not a fail.
  assert.equal(evaluateOffer(offer({ salary: { min: 50000, max: 70000, currency: "USD", period: "year", published: true } }), eur).perCriterion.salary.status, "unknown");
  // Different period: unknown even when the numbers look compatible.
  assert.equal(evaluateOffer(offer({ salary: { min: 5000, max: 6000, currency: "EUR", period: "month", published: true } }), eur).perCriterion.salary.status, "unknown");
  const unpublished = offer({ salary: { published: false } });
  assert.equal(evaluateOffer(unpublished, eur).perCriterion.salary.status, "unknown");
  assert.equal(evaluateOffer(unpublished, eur).canAutoApply, false);
  assert.equal(evaluateOffer(unpublished, { salary: { min: 40000, currency: "EUR", period: "year", unknownPolicy: "exclude" } }).eligible, false);
  assert.equal(evaluateOffer(unpublished, { salary: { min: 40000, currency: "EUR", period: "year", unknownPolicy: "include" } }).perCriterion.salary.status, "pass");
});

test("filters: tri-state unknowns — sponsorship, relocation, authorisation never default to yes", () => {
  const profile = { authorisationByCountry: { ES: "yes", US: "no", DE: "unknown" } };
  const criteria = {
    sponsorship: { requires: true, unknownPolicy: "review" },
    relocation: { requires: true, unknownPolicy: "review" },
    authorisation: { unknownPolicy: "review" },
  };
  const r = evaluateOffer(offer({ sponsorship: "unknown", relocation: "unknown" }), criteria, profile);
  assert.equal(r.perCriterion.sponsorship.status, "unknown");
  assert.equal(r.perCriterion.relocation.status, "unknown");
  assert.equal(r.canAutoApply, false);
  assert.equal(r.needsReview, true);
  // Authorisation 'no' for the offer country is a hard exclusion.
  const us = evaluateOffer(offer({ location: { country: "US", region: "", city: "New York", raw: "New York", remote: false } }), criteria, profile);
  assert.equal(us.perCriterion.authorisation.status, "fail");
  assert.ok(us.hardFailed.includes("authorisation"));
  assert.equal(us.eligible, false);
  // Authorisation 'unknown' is unknown, not a pass.
  const de = evaluateOffer(offer({ location: { country: "DE", region: "", city: "Berlin", raw: "Berlin", remote: false } }), criteria, profile);
  assert.equal(de.perCriterion.authorisation.status, "unknown");
  // Sponsorship 'no' when required is a hard failure.
  const noSpon = evaluateOffer(offer({ sponsorship: "no" }), criteria, profile);
  assert.equal(noSpon.perCriterion.sponsorship.status, "fail");
  assert.ok(noSpon.hardFailed.includes("sponsorship"));
});

test("filters: hard exclusions prevail — blocked company, excluded title/skill, wrong language, already-sent", () => {
  const criteria = {
    language: "en",
    companies: { blocked: ["Blocked Test Corp"] },
    excludedTitles: ["Intern"],
    excludedSkills: ["COBOL"],
    sentCanonicalIds: ["ats:greenhouse|tenant:acme|posting:p-1"],
  };
  assert.ok(evaluateOffer(offer({ company: "Blocked Test Corp" }), criteria).hardFailed.includes("companies"));
  assert.ok(evaluateOffer(offer({ title: "Finance Intern" }), criteria).hardFailed.includes("excludedTitles"));
  assert.ok(evaluateOffer(offer({ skills: ["COBOL"] }), criteria).hardFailed.includes("excludedSkills"));
  const spanish = evaluateOffer(offer({ language: "es", description: "Gerente de finanzas." }), criteria);
  assert.equal(spanish.perCriterion.language.status, "fail");
  assert.ok(spanish.hardFailed.includes("language"));
  const sent = evaluateOffer(offer(), criteria);
  assert.ok(sent.hardFailed.includes("alreadySent"));
  assert.equal(sent.eligible, false);
  // Whole-word: 'Sales' exclusion must not fire on 'Salesforce'.
  const sales = evaluateOffer(offer({ title: "Salesforce Administrator", description: "Salesforce admin." }), { excludedTitles: ["Sales"] });
  assert.equal(sales.perCriterion.excludedTitles.status, "pass");
  const salesManager = evaluateOffer(offer({ title: "Sales Manager" }), { excludedTitles: ["Sales"] });
  assert.equal(salesManager.perCriterion.excludedTitles.status, "fail");
});

test("filters: unknown publication date is marked unknown, never assumed recent", () => {
  const r = evaluateOffer(offer({ publishedAt: null }), { publishedWithinDays: 7 });
  assert.equal(r.perCriterion.publishedWithin.status, "unknown");
  assert.equal(r.canAutoApply, false);
  const closed = evaluateOffer(offer({ status: "closed" }), {});
  assert.equal(closed.eligible, false);
  assert.ok(closed.hardFailed.includes("status"));
});

test("filters: absent criteria are not_applicable, not failures", () => {
  const r = evaluateOffer(offer(), {});
  assert.equal(r.eligible, true);
  assert.equal(r.perCriterion.countries, undefined);
  assert.equal(r.perCriterion.salary.status, "not_applicable");
  assert.equal(r.perCriterion.sponsorship.status, "not_applicable");
});
