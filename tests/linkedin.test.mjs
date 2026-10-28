// F3 LinkedIn, assisted only (T-V2-030, RF-V2-032/033). No LinkedIn
// login, crawl, automation or scraping anywhere here: buildSearchUrl
// only composes public search parameters, and imports only handle
// user-supplied URLs, text and CSV.
import test from "node:test";
import assert from "node:assert/strict";
import {
  LINKEDIN_ASSISTED,
  buildSearchUrl,
  saveLink,
  importUrl,
  importCsv,
  importText,
  resolveExternal,
} from "../packages/shared/linkedin.mjs";

test("T-V2-030: buildSearchUrl uses only LinkedIn's supported public search params", () => {
  const url = buildSearchUrl({ keywords: "Finance Manager", location: "Madrid", workMode: "remote", jobType: "full-time", experience: "senior" });
  const parsed = new URL(url);
  assert.equal(parsed.hostname, "www.linkedin.com");
  assert.equal(parsed.pathname, "/jobs/search/");
  assert.equal(parsed.searchParams.get("keywords"), "Finance Manager");
  assert.equal(parsed.searchParams.get("location"), "Madrid");
  assert.equal(parsed.searchParams.get("f_WT"), "2");
  assert.equal(parsed.searchParams.get("f_JT"), "F");
  assert.equal(parsed.searchParams.get("f_E"), "4");
  const onsite = new URL(buildSearchUrl({ workMode: "onsite" }));
  assert.equal(onsite.searchParams.get("f_WT"), "1");
  const hybrid = new URL(buildSearchUrl({ workMode: "hybrid" }));
  assert.equal(hybrid.searchParams.get("f_WT"), "3");
  // Unknown filter values are omitted, never guessed into a code.
  const unknown = new URL(buildSearchUrl({ workMode: "moon", jobType: "whatever" }));
  assert.equal(unknown.searchParams.get("f_WT"), null);
  assert.equal(unknown.searchParams.get("f_JT"), null);
});

test("T-V2-030: saveLink only accepts LinkedIn URLs and labels them assisted", () => {
  const saved = saveLink("https://www.linkedin.com/jobs/view/123", { title: "Finance Manager" });
  assert.equal(saved.mode, "assisted");
  assert.equal(saved.provenance, "linkedin-assisted");
  assert.equal(saved.easyApplyExecuted, false);
  assert.ok(saved.savedAt);
  assert.throws(() => saveLink("https://example.test/jobs/1"), /not a LinkedIn URL/);
  assert.throws(() => saveLink("http://www.linkedin.com/jobs/view/1"), /only https/);
});

test("T-V2-030: importCsv parses quoted commas and keeps provenance; rows without a URL are skipped", () => {
  const csv = [
    "title,company,url,location",
    '"Finance Manager, Group","Example, Corp",https://example.test/jobs/1,Madrid',
    "Controller,Other Corp,,London",
    "FP&A Manager,Third Corp,https://example.test/jobs/2,Remote",
  ].join("\n");
  const rows = importCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, "Finance Manager, Group");
  assert.equal(rows[0].company, "Example, Corp");
  assert.equal(rows[0].url, "https://example.test/jobs/1");
  assert.equal(rows[0].provenance, "linkedin-csv-import");
  assert.equal(rows[0].status, "pending_extraction");
  assert.equal(rows[0].applyUrl, null);
  assert.equal(rows[1].provenance, "linkedin-csv-import");
});

test("T-V2-030: importText extracts and dedupes URLs with provenance", () => {
  const rows = importText("See this: https://example.test/jobs/1 and again https://example.test/jobs/1, plus https://example.test/jobs/2.");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, "https://example.test/jobs/1");
  assert.equal(rows[1].url, "https://example.test/jobs/2");
  assert.ok(rows.every((row) => row.provenance === "linkedin-text-import"));
});

test("T-V2-030: importUrl resolves through the injected extractor and never invents an apply URL", async () => {
  const extractFn = async (url) => {
    assert.equal(url, "https://example.test/jobs/9");
    return { status: "ok", title: "Finance Manager", company: "Example Corp", description: "Long body.", language: "en" };
  };
  const candidate = await importUrl("https://example.test/jobs/9", { extractFn });
  assert.equal(candidate.provenance, "linkedin-import");
  assert.equal(candidate.title, "Finance Manager");
  assert.equal(candidate.status, "extracted");
  const pending = await importUrl("https://example.test/jobs/10");
  assert.equal(pending.status, "pending_extraction");
  assert.equal(pending.applyUrl, null);
});

test("T-V2-030: resolveExternal is certain only on URL match; company+title is uncertain, never certain", () => {
  const known = [
    { canonicalUrl: "https://example.test/jobs/1?utm_source=linkedin", applyUrl: "https://example.test/jobs/1/apply", title: "Finance Manager", company: "Example Corp" },
    { canonicalUrl: "https://example.test/jobs/2", title: "Controller", company: "Other Corp" },
  ];
  const byUrl = resolveExternal({ url: "https://example.test/jobs/1" }, known);
  assert.equal(byUrl.matched, true);
  assert.equal(byUrl.certainty, "certain");
  assert.equal(byUrl.reason, "canonical_url");
  const weak = resolveExternal({ title: "Finance Manager", company: "Example Corp" }, known);
  assert.equal(weak.matched, true);
  assert.equal(weak.certainty, "uncertain");
  assert.equal(weak.reason, "company_title_weak_match");
  const none = resolveExternal({ title: "Treasurer", company: "Nobody Corp" }, known);
  assert.equal(none.matched, false);
  assert.equal(none.certainty, "none");
  assert.equal(none.offer, null);
});

test("T-V2-030: Easy Apply is NEVER executed", () => {
  assert.equal(LINKEDIN_ASSISTED.easyApplyExecuted, false);
  assert.equal(LINKEDIN_ASSISTED.mode, "assisted");
});
