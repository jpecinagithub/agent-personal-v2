// Parent regression (F3 integration review): per-source run-summary counts
// must be attributed by connector, not lost to an ATS-vs-connector id
// mismatch. ATS normalizers stamp offers with the ATS id ("greenhouse")
// while perSource is keyed by connector id ("greenhouse-catalog"); an
// earlier version therefore reported valid:0 / excluded:0 on completed
// runs (RF-V2-039). Self-contained server with injected mock fetch.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../apps/server/server.mjs";

const BODY = "We are looking for a candidate to lead the team and manage budgeting, forecasting and reporting across the business. IFRS experience required.";
const resp = (status, body) => ({ status, ok: status >= 200 && status < 300,
  headers: { get: () => null }, json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
async function mockFetch(url) {
  const t = String(url);
  if (t.includes("boards-api.greenhouse.io") && t.includes("/boards/cnt/jobs")) {
    return resp(200, [
      { id: "c-fin", title: "Finance Manager", absolute_url: "https://example.test/jobs/c-fin", location: { name: "Hybrid, Logroño, ES" }, updated_at: "2026-10-27T00:00:00Z", content: BODY },
      { id: "c-jun", title: "Junior Finance Assistant", absolute_url: "https://example.test/jobs/c-jun", location: { name: "Hybrid, Logroño, ES" }, updated_at: "2026-10-27T00:00:00Z", content: BODY },
    ]);
  }
  return resp(404, { error: "not found" });
}

test("run summary attributes valid/excluded counts to the connector source", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-counts-"));
  const { server } = createServer({ dataDir: dir, fetchFn: mockFetch });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  try {
    const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (server.address()).port}`;
    const api = async (m, p, b) => {
      const res = await fetch(`${base}${p}`, { method: m, headers: { "Content-Type": "application/json" }, body: b === undefined ? undefined : JSON.stringify(b) });
      return { status: res.status, data: await res.json().catch(() => ({})) };
    };
    const person = await api("POST", "/api/person", { full_name: "Counts Person", email: "counts@example.test",
      employment: [{ id: "job-1", employer: "Counts Bank", title: "Finance Manager", start: "2020-01" }] });
    assert.equal(person.status, 201, JSON.stringify(person.data));
    const profile = await api("POST", "/api/profiles", { personId: person.data.id, name: "Finanzas",
      body: { desired_roles: ["Finance Manager"], locations: ["ES"], skills: ["IFRS"] } });
    assert.equal(profile.status, 201, JSON.stringify(profile.data));
    const board = await api("POST", "/api/company-boards", { company: "Counts", ats: "greenhouse", board: "cnt" });
    const ver = await api("POST", `/api/company-boards/${board.data.board.id}/verify`, {});
    assert.equal(ver.data.ok, true, JSON.stringify(ver.data));
    const def = await api("POST", "/api/search-definitions", { personId: person.data.id, name: "Counts",
      profileIds: [profile.data.id], titles: { any: ["Finance Manager"], exclude: ["Junior"] },
      locations: { countries: ["ES"], remoteCountries: ["ES"] }, workModes: ["remote", "hybrid"],
      offerLanguage: "en", sources: ["greenhouse-catalog"],
      schedule: { timezone: "Europe/Madrid", localTimes: ["09:00"], enabled: false },
      action: "save", limits: { maxJobs: 100, maxPagesPerSource: 10 } });
    assert.equal(def.status, 201, JSON.stringify(def.data));
    const run = await api("POST", `/api/search-definitions/${def.data.definition.id}/run`, {});
    assert.equal(run.status, 200, JSON.stringify(run.data));
    const perSource = run.data.summary.perSource.find((s) => s.source === "greenhouse-catalog");
    assert.equal(perSource.observed, 2);
    // Pipeline semantics (kept, not partitioned): valid = offers kept after
    // dedupe/sent-exclusion (both jobs); excluded = hard-excluded at ranking
    // (Junior, counted additionally from the first profile's ranking).
    // The regression being guarded is valid/excluded staying 0 on a
    // completed run because of the ATS-vs-connector id mismatch.
    assert.equal(perSource.valid, 2, "kept offers count as valid for their connector (never 0 on a completed run)");
    assert.equal(perSource.excluded, 1, "Junior offer hard-excluded by title counts against its connector");
    assert.equal(run.data.summary.valid, 2);
    assert.equal(run.data.summary.excluded, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
