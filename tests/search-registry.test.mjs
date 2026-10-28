// F3 T-V2-025: connector registry, capability compilation, pause
// isolation, and failure-is-not-zero.
import test from "node:test";
import assert from "node:assert/strict";
import {
  listConnectors, getConnector, pauseConnector, resumeConnector,
  compileCriteria, sourceFailure, isSourceFailure,
} from "../packages/shared/search-registry.mjs";

test("registry: at least the six honest connectors are registered", () => {
  const ids = listConnectors().map((c) => c.id);
  for (const id of ["greenhouse-catalog", "lever-catalog", "ashby-catalog", "xai-web", "linkedin-assisted", "manual-import"]) {
    assert.ok(ids.includes(id), `missing connector ${id}`);
  }
  const gh = getConnector("greenhouse-catalog");
  assert.equal(gh.ats, "greenhouse");
  assert.equal(gh.mode, "auto");
  assert.equal(gh.status, "active");
  assert.equal(getConnector("nope"), null);
});

test("registry: ATS catalogs claim title/location native, everything else postprocessed, no global search", () => {
  for (const id of ["greenhouse-catalog", "lever-catalog", "ashby-catalog"]) {
    const c = getConnector(id);
    assert.equal(c.capabilities.title, "native", id);
    assert.equal(c.capabilities.location, "native", id);
    assert.equal(c.capabilities.salary, "postprocessed", id);
    assert.equal(c.capabilities.sponsorship, "postprocessed", id);
    assert.equal(c.capabilities.globalSearch, "unsupported", id);
    assert.equal(c.capabilities.authorisation, "unsupported", id);
  }
  // LinkedIn is assisted, not automatic; manual import has no search.
  assert.equal(getConnector("linkedin-assisted").mode, "assisted");
  assert.equal(getConnector("manual-import").mode, "assisted");
  assert.equal(getConnector("manual-import").capabilities.globalSearch, "unsupported");
});

test("registry: compileCriteria splits native / postprocessed / unsupported per source", () => {
  const criteria = {
    titles: ["Finance Manager"], countries: ["ES"], salary: { min: 40000, currency: "EUR", period: "year" },
    sponsorship: { requires: true }, authorisation: { unknownPolicy: "review" },
  };
  const gh = compileCriteria(criteria, "greenhouse-catalog");
  assert.deepEqual(Object.keys(gh.nativeQuery).sort(), ["countries", "titles"]);
  assert.ok(gh.postprocessed.includes("salary"));
  assert.ok(gh.postprocessed.includes("sponsorship"));
  assert.ok(gh.unsupported.includes("authorisation"));
  const manual = compileCriteria(criteria, "manual-import");
  assert.deepEqual(Object.keys(manual.nativeQuery), []);
  assert.ok(manual.postprocessed.includes("titles"));
  assert.throws(() => compileCriteria(criteria, "unknown-connector"), /unknown connector/);
  assert.throws(() => compileCriteria(criteria, null), /unknown connector/);
  // A bare object connector resolves by its own capabilities (here: none, so all unsupported).
  assert.deepEqual(compileCriteria({ countries: ["ES"] }, { id: "ghost", capabilities: {} }).unsupported, ["countries"]);
  // An object connector resolves by its own capabilities, too.
  const byObject = compileCriteria({ countries: ["ES"] }, getConnector("lever-catalog"));
  assert.deepEqual(byObject.nativeQuery, { countries: ["ES"] });
});

test("registry: pausing one connector never affects the others", () => {
  pauseConnector("ashby-catalog", "test pause");
  assert.equal(getConnector("ashby-catalog").status, "paused");
  assert.equal(getConnector("ashby-catalog").degradeReason, "test pause");
  assert.equal(getConnector("greenhouse-catalog").status, "active");
  assert.equal(getConnector("lever-catalog").status, "active");
  assert.equal(getConnector("xai-web").status, "active");
  resumeConnector("ashby-catalog");
  assert.equal(getConnector("ashby-catalog").status, "active");
  assert.equal(getConnector("ashby-catalog").degradeReason, null);
});

test("registry: a source failure is a failure record, never zero results", () => {
  for (const status of ["failed", "rate_limited", "blocked", "unavailable"]) {
    const f = sourceFailure(status, "upstream refused");
    assert.equal(isSourceFailure(f), true);
    assert.notEqual(f.status, "completed_zero_results");
  }
  assert.equal(isSourceFailure({ status: "completed_zero_results" }), false);
  assert.equal(isSourceFailure(null), false);
  assert.throws(() => sourceFailure("completed", "ok"), /unknown source failure status/);
  assert.throws(() => sourceFailure("failed", "  "), /cause is required/);
});
