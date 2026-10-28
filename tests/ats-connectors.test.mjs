// F3 connectors (T-V2-026/027/028). All network via injected mock fetch:
// no test here ever touches the real network.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ATS_CAPABILITIES,
  fetchGreenhouseJobs,
  fetchGreenhouseJob,
  fetchLeverPostings,
  fetchAshbyJobs,
  fetchAshbyJob,
  normalizeGreenhouseJob,
} from "../packages/shared/ats-connectors.mjs";

function jsonRes(body, { status = 200, retryAfter = null } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (String(name).toLowerCase() === "retry-after" ? retryAfter : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const GH_JOB = {
  id: 4242,
  title: "Finance Manager",
  absolute_url: "https://boards.greenhouse.io/example/jobs/4242",
  location: { name: "London, England, United Kingdom" },
  content: "<p>Lead the <b>finance</b> team.</p>",
  updated_at: "2026-10-27T09:00:00Z",
};

const LEVER_PAGE = [
  {
    id: "abc-1",
    text: "Financial Controller",
    hostedUrl: "https://jobs.lever.co/example/abc-1",
    applyUrl: "https://jobs.lever.co/example/abc-1/apply",
    categories: { location: "Remote", team: "Finance", commitment: "Full-time" },
    descriptionPlain: "Own the close process.",
    createdAt: 1761542400000,
  },
];

const ASHBY_BOARD = {
  jobs: [
    {
      id: "ash-1",
      title: "FP&A Manager",
      locationName: "Dublin, Ireland",
      jobUrl: "https://jobs.ashbyhq.com/example/ash-1",
      descriptionHtml: "<p>Own planning.</p>",
      publishedAt: "2026-10-20T00:00:00Z",
      isListed: true,
    },
    {
      id: "ash-hidden",
      title: "Hidden Role",
      locationName: "Remote",
      jobUrl: "https://jobs.ashbyhq.com/example/ash-hidden",
      descriptionHtml: "<p>Not listed.</p>",
      publishedAt: "2026-10-20T00:00:00Z",
      isListed: false,
    },
  ],
};

test("T-V2-026: Greenhouse list normalizes title/company/location/URLs and never invents publishedAt", async () => {
  const fetchFn = async (url) => {
    assert.match(url, /boards-api\.greenhouse\.io\/v1\/boards\/example\/jobs$/);
    return jsonRes({ jobs: [GH_JOB] });
  };
  const result = await fetchGreenhouseJobs("example", { fetchFn, company: "Example Corp" });
  assert.equal(result.status, "ok");
  assert.equal(result.jobs.length, 1);
  const job = result.jobs[0];
  assert.equal(job.title, "Finance Manager");
  assert.equal(job.company, "Example Corp");
  assert.equal(job.canonicalUrl, "https://boards.greenhouse.io/example/jobs/4242");
  assert.equal(job.applyUrl, "https://boards.greenhouse.io/example/jobs/4242");
  assert.equal(job.location.city, "London");
  assert.equal(job.location.country, "United Kingdom");
  assert.equal(job.description, "Lead the finance team.");
  assert.equal(job.publishedAt, null);
  assert.match(job.evidence.lastObserved, /2026-10-27/);
  assert.equal(job.postingId, "4242");
  assert.equal(job.ats, "greenhouse");
});

test("T-V2-026: Greenhouse has no pagination — cursor is always null", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...GH_JOB, id: i + 1 }));
  const result = await fetchGreenhouseJobs("example", { fetchFn: async () => jsonRes({ jobs: many }) });
  assert.equal(result.status, "ok");
  assert.equal(result.jobs.length, 30);
  assert.equal(result.cursor, null);
  assert.equal(ATS_CAPABILITIES.greenhouse.pagination, "none");
});

test("T-V2-026: Greenhouse detail normalizes a single job", async () => {
  const result = await fetchGreenhouseJob("example", 4242, {
    fetchFn: async (url) => {
      assert.match(url, /\/jobs\/4242$/);
      return jsonRes(GH_JOB);
    },
    company: "Example Corp",
  });
  assert.equal(result.status, "ok");
  assert.equal(result.jobs[0].title, "Finance Manager");
  assert.equal(normalizeGreenhouseJob({ ...GH_JOB, title: undefined }, { board: "example" }).title, "unknown");
});

test("T-V2-026/027/028: a failed source is never an empty success", async () => {
  const failed = await fetchGreenhouseJobs("example", { fetchFn: async () => jsonRes({}, { status: 500 }) });
  assert.notEqual(failed.status, "ok");
  assert.equal(failed.jobs.length, 0);
  assert.match(failed.cause, /http_500/);
  const network = await fetchLeverPostings("example", { fetchFn: async () => { throw new Error("socket hangup"); } });
  assert.equal(network.status, "unavailable");
  assert.match(network.cause, /network/);
});

test("T-V2-026/027/028: 429 maps to rate_limited with Retry-After, 403 to blocked, 401 to auth_required", async () => {
  const limited = await fetchAshbyJobs("example", { fetchFn: async () => jsonRes({}, { status: 429, retryAfter: "5" }) });
  assert.equal(limited.status, "rate_limited");
  assert.equal(limited.retryAfterMs, 5000);
  const blocked = await fetchGreenhouseJobs("example", { fetchFn: async () => jsonRes({}, { status: 403 }) });
  assert.equal(blocked.status, "blocked");
  const auth = await fetchLeverPostings("example", { fetchFn: async () => jsonRes({}, { status: 401 }) });
  assert.equal(auth.status, "auth_required");
});

test("T-V2-027: Lever skip/limit pagination returns the next skip only on a full page", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return jsonRes(LEVER_PAGE);
  };
  const full = await fetchLeverPostings("example", { fetchFn, skip: 0, limit: 1 });
  assert.equal(full.status, "ok");
  assert.deepEqual(full.cursor, { skip: 1, limit: 1 });
  assert.match(calls[0], /skip=0&limit=1&mode=json/);
  const partial = await fetchLeverPostings("example", { fetchFn, skip: 10, limit: 50 });
  assert.equal(partial.cursor, null);
  const job = full.jobs[0];
  assert.equal(job.applyUrl, "https://jobs.lever.co/example/abc-1/apply");
  assert.equal(job.canonicalUrl, "https://jobs.lever.co/example/abc-1");
  assert.equal(job.workMode, "remote");
  assert.equal(job.contractType, "Full-time");
  assert.equal(job.publishedAt, "2025-10-27T05:20:00.000Z");
});

test("T-V2-027: Lever normalizes defensively — missing text fields become unknown, never invented", async () => {
  const result = await fetchLeverPostings("example", {
    fetchFn: async () => jsonRes([{ id: "x-1" }]),
  });
  assert.equal(result.status, "ok");
  assert.equal(result.jobs[0].title, "unknown");
  assert.equal(result.jobs[0].canonicalUrl, null);
  assert.equal(result.jobs[0].publishedAt, null);
});

test("T-V2-027: the public Lever API exposes NO custom application questions (documented capability)", () => {
  assert.equal(ATS_CAPABILITIES.lever.customApplicationQuestions, false);
  assert.match(ATS_CAPABILITIES.lever.customApplicationQuestionsNote, /NO custom application questions/);
  assert.equal(ATS_CAPABILITIES.greenhouse.globalSearch, false);
  assert.equal(ATS_CAPABILITIES.lever.globalSearch, false);
  assert.equal(ATS_CAPABILITIES.ashby.globalSearch, false);
});

test("T-V2-028: Ashby excludes isListed=false entries with an explicit recorded reason", async () => {
  const result = await fetchAshbyJobs("example", { fetchFn: async () => jsonRes(ASHBY_BOARD) });
  assert.equal(result.status, "ok");
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].title, "FP&A Manager");
  assert.equal(result.jobs[0].publishedAt, "2026-10-20T00:00:00Z");
  assert.equal(result.cursor, null);
  assert.deepEqual(result.excluded, [{ postingId: "ash-hidden", reason: "not_listed" }]);
  const detail = await fetchAshbyJob("example", "ash-hidden", { fetchFn: async () => jsonRes(ASHBY_BOARD) });
  assert.notEqual(detail.status, "ok");
  assert.match(detail.cause, /not_listed/);
});
