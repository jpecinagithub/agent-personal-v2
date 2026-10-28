// F3 xAI discovery support (T-V2-029, RF-V2-029). This module never
// calls xAI: tests prove queries carry no personal data and validation
// only uses the injected fetchFn.
import test from "node:test";
import assert from "node:assert/strict";
import { generateQueries, validateDiscovery, MAX_DISCOVERY_QUERIES } from "../packages/shared/xai-discovery.mjs";

function pageRes(html, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => html,
  };
}

test("T-V2-029: generateQueries builds queries from titles and locations only", () => {
  const queries = generateQueries({ titles: ["Finance Manager", "FP&A Manager"], locations: ["Madrid", "Remote Europe"] });
  assert.equal(queries.length, 4);
  assert.ok(queries.includes('"Finance Manager" jobs Madrid'));
  assert.ok(queries.includes('"FP&A Manager" jobs Remote Europe'));
  // Extra fields (personal data, CV content) are ignored, never queried.
  const personal = { fullName: "Some Person", cv: "Confidential CV text about previous employers", email: "person@example.test" };
  const withPersonal = generateQueries({ titles: ["Finance Manager"], locations: ["Madrid"], ...personal });
  assert.deepEqual(withPersonal, ['"Finance Manager" jobs Madrid']);
  for (const query of withPersonal) {
    assert.doesNotMatch(query, /Some Person|Confidential|example\.test/);
  }
  assert.deepEqual(generateQueries({ titles: [] }), []);
  assert.deepEqual(generateQueries({ titles: ["Controller"] }), ['"Controller" jobs careers']);
});

test("T-V2-029: generateQueries caps the query count", () => {
  const titles = Array.from({ length: 10 }, (_, i) => `Title ${i}`);
  const locations = Array.from({ length: 10 }, (_, i) => `City ${i}`);
  const queries = generateQueries({ titles, locations });
  assert.equal(queries.length, MAX_DISCOVERY_QUERIES);
});

test("T-V2-029: validateDiscovery verifies title+company against the fetched page", async () => {
  const html = "<html><body><h1>Finance Manager</h1><p>Example Corp is hiring a finance manager for its team.</p></body></html>";
  const verified = await validateDiscovery("https://example.test/jobs/1", {
    fetchFn: async () => pageRes(html),
    expectedTitle: "Finance Manager",
    expectedCompany: "Example Corp",
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.reason, "title_and_company_match");
  assert.deepEqual(verified.citations, ["https://example.test/jobs/1"]);
  assert.equal(verified.titleMatch, true);
  assert.equal(verified.companyMatch, true);
  const mismatch = await validateDiscovery("https://example.test/jobs/2", {
    fetchFn: async () => pageRes("<html><body><h1>Sales Assistant</h1><p>Other Corp retail role.</p></body></html>"),
    expectedTitle: "Finance Manager",
    expectedCompany: "Example Corp",
  });
  assert.equal(mismatch.verified, false);
  assert.equal(mismatch.titleMatch, false);
  assert.equal(mismatch.companyMatch, false);
});

test("T-V2-029: validateDiscovery never verifies against nothing, and fetch failure is not verification", async () => {
  const nothing = await validateDiscovery("https://example.test/jobs/1", { fetchFn: async () => pageRes("<html></html>") });
  assert.equal(nothing.verified, false);
  assert.equal(nothing.reason, "nothing_to_check_against");
  const failed = await validateDiscovery("https://example.test/jobs/1", {
    fetchFn: async () => { throw new Error("socket hangup"); },
    expectedTitle: "Finance Manager",
  });
  assert.equal(failed.verified, false);
  assert.match(failed.reason, /fetch_failed/);
  const http = await validateDiscovery("https://example.test/jobs/1", {
    fetchFn: async () => pageRes("", { status: 404 }),
    expectedTitle: "Finance Manager",
  });
  assert.equal(http.verified, false);
  assert.equal(http.reason, "http_404");
});

test("T-V2-029: the discovery module never calls xAI — only the injected fetchFn is used", async () => {
  const called = [];
  const fetchFn = async (url) => {
    called.push(url);
    return pageRes("<html><body>Finance Manager at Example Corp</body></html>");
  };
  await validateDiscovery("https://example.test/jobs/1", { fetchFn, expectedTitle: "Finance Manager", expectedCompany: "Example Corp" });
  generateQueries({ titles: ["Finance Manager"], locations: ["Madrid"] });
  assert.deepEqual(called, ["https://example.test/jobs/1"]);
  assert.ok(called.every((url) => !url.includes("api.x.ai")));
});
