// F3 company catalog (T-V2-029, RF-V2-031). DB-backed tests use a
// throwaway temp database; network via injected mock fetch only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import {
  addBoard,
  getBoardByAtsBoard,
  listBoards,
  pauseBoard,
  requireVerifiedBoard,
  seedCatalog,
  verifyBoard,
  SEED_BOARDS,
} from "../packages/shared/company-catalog.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-catalog-"));
  return openDatabase(path.join(dir, "agentv2.db"));
}

function jsonRes(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const GH_OK = async () => jsonRes({ jobs: [{ id: 1, title: "Finance Manager", absolute_url: "https://boards.greenhouse.io/x/jobs/1", location: { name: "Remote" }, content: "x", updated_at: "2026-10-27T00:00:00Z" }] });
const FAIL_500 = async () => jsonRes({}, { status: 500 });

test("T-V2-029: addBoard validates slugs and rejects duplicates", () => {
  const db = setup();
  assert.throws(() => addBoard(db, { company: "Bad", ats: "greenhouse", board: "Bad Slug!" }), /invalid board slug/);
  assert.throws(() => addBoard(db, { company: "Bad", ats: "greenhouse", board: "UpperCase" }), /invalid board slug/);
  assert.throws(() => addBoard(db, { company: "Bad", ats: "workday", board: "bad" }), /unknown ats/);
  assert.throws(() => addBoard(db, { company: "Bad", ats: "greenhouse", board: "bad", region: "US" }), /invalid region/);
  const row = addBoard(db, { company: "Example Corp", ats: "greenhouse", board: "example" });
  assert.equal(row.verified_at, null);
  assert.equal(row.paused, false);
  assert.throws(() => addBoard(db, { company: "Example Corp", ats: "greenhouse", board: "example" }), /already exists/);
});

test("T-V2-029: seedCatalog loads the F0 boards, all UNVERIFIED", () => {
  const db = setup();
  assert.ok(SEED_BOARDS.length >= 20);
  const result = seedCatalog(db);
  assert.equal(result.inserted, SEED_BOARDS.length);
  assert.equal(result.total, SEED_BOARDS.length);
  for (const row of listBoards(db)) assert.equal(row.verified_at, null);
  assert.ok(getBoardByAtsBoard(db, "greenhouse", "stripe"));
  assert.ok(getBoardByAtsBoard(db, "ashby", "ramp"));
  assert.ok(getBoardByAtsBoard(db, "lever", "palantir"));
  // Lowercased F0 spellings ("Crusoe", "Ubisoft2") under the slug rule.
  assert.ok(getBoardByAtsBoard(db, "ashby", "crusoe"));
  assert.ok(getBoardByAtsBoard(db, "smartrecruiters", "ubisoft2"));
  const again = seedCatalog(db);
  assert.equal(again.inserted, 0);
  assert.equal(again.skipped, SEED_BOARDS.length);
});

test("T-V2-029: an unverified board is rejected until verification succeeds", async () => {
  const db = setup();
  const row = addBoard(db, { company: "Example Corp", ats: "greenhouse", board: "example" });
  assert.throws(() => requireVerifiedBoard(db, "greenhouse", "example"), /board_not_verified/);
  assert.throws(() => requireVerifiedBoard(db, "greenhouse", "missing"), /board_not_found/);
  const verified = await verifyBoard(db, row.id, { fetchFn: GH_OK, verifiedBy: "tester" });
  assert.equal(verified.ok, true);
  const after = requireVerifiedBoard(db, "greenhouse", "example");
  assert.ok(after.verified_at);
  assert.equal(after.verified_by, "tester");
});

test("T-V2-029: a failed verification records the reason and leaves the board unverified", async () => {
  const db = setup();
  const row = addBoard(db, { company: "Example Corp", ats: "greenhouse", board: "example" });
  const failed = await verifyBoard(db, row.id, { fetchFn: FAIL_500, verifiedBy: "tester" });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, "unavailable");
  const after = getBoardByAtsBoard(db, "greenhouse", "example");
  assert.equal(after.verified_at, null);
  assert.equal(after.verified_by, null);
  assert.match(after.last_error, /http_500/);
  assert.throws(() => requireVerifiedBoard(db, "greenhouse", "example"), /board_not_verified/);
});

test("T-V2-029: verifyBoard uses a small limit for Lever and pauses block usability", async () => {
  const db = setup();
  const row = addBoard(db, { company: "Example Corp", ats: "lever", board: "example" });
  let seenUrl = "";
  const fetchFn = async (url) => {
    seenUrl = url;
    return jsonRes([{ id: "l-1", text: "Finance Manager", hostedUrl: "https://jobs.lever.co/example/l-1" }]);
  };
  const verified = await verifyBoard(db, row.id, { fetchFn, verifiedBy: "tester" });
  assert.equal(verified.ok, true);
  assert.match(seenUrl, /limit=1/);
  pauseBoard(db, row.id, true);
  assert.throws(() => requireVerifiedBoard(db, "lever", "example"), /board_paused/);
  assert.equal(listBoards(db, { includePaused: false }).length, 0);
  assert.equal(listBoards(db, { onlyVerified: true }).length, 1);
  pauseBoard(db, row.id, false);
  assert.ok(requireVerifiedBoard(db, "lever", "example").verified_at);
});

test("T-V2-029: SmartRecruiters boards catalogue but never verify in F3", async () => {
  const db = setup();
  seedCatalog(db, [{ company: "Ubisoft", ats: "smartrecruiters", board: "ubisoft2" }]);
  const row = getBoardByAtsBoard(db, "smartrecruiters", "ubisoft2");
  const result = await verifyBoard(db, row.id, { fetchFn: GH_OK });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported_ats");
  assert.equal(getBoardByAtsBoard(db, "smartrecruiters", "ubisoft2").verified_at, null);
});
