// T-V2-011: claim-once, fencing, pause/resume/cancel, restart recovery.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openDatabase } from "../packages/shared/db.mjs";
import { enqueue, claim, complete, fail, pauseJob, resumeJob, cancelJob, recover, getJob } from "../packages/shared/queue.mjs";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-q-"));
  const dbPath = path.join(dir, "agentv2.db");
  return { dir, dbPath, db: openDatabase(dbPath) };
}

test("claim is once, fencing rejects stale tokens, pause/resume/cancel work", () => {
  const { db } = tmpDb();
  const id = enqueue(db, "search", { board: "synthetic-fixture" });
  const job = claim(db, "worker-a");
  assert.equal(job.id, id);
  assert.equal(claim(db, "worker-b"), null, "a second worker must not claim claimed work");
  assert.throws(() => complete(db, id, "wrong-token"), /fencing token mismatch/);
  complete(db, id, job.lease_token, { ok: true });
  assert.equal(getJob(db, id).status, "done");

  const p = enqueue(db, "search", {});
  pauseJob(db, p);
  assert.equal(getJob(db, p).status, "paused");
  assert.equal(claim(db, "worker-a"), null, "paused work is not claimable");
  resumeJob(db, p);
  const claimed = claim(db, "worker-a");
  assert.equal(claimed.id, p);
  assert.throws(() => cancelJob(db, p), /only a pending or paused job can be cancelled/);
  fail(db, p, claimed.lease_token, { reason: "synthetic failure" });
  assert.equal(getJob(db, p).status, "failed");
  const c = enqueue(db, "search", {});
  cancelJob(db, c);
  assert.equal(getJob(db, c).status, "cancelled");
});

test("restart recovery: a killed worker's work is not duplicated", () => {
  const { dbPath } = tmpDb();
  const db0 = openDatabase(dbPath);
  const id = enqueue(db0, "search", { board: "synthetic-fixture" });
  db0.close();
  // Separate process claims and dies without completing (lease 60 s).
  const childOut = execFileSync(process.execPath, ["tests/helpers/claim-child.mjs", dbPath], { cwd: new URL("..", import.meta.url).pathname }).toString().trim();
  const child = JSON.parse(childOut);
  assert.equal(child.id, id);
  // Reopening while the lease is live must NOT hand the job to anyone else.
  const db1 = openDatabase(dbPath);
  assert.equal(recover(db1), 0, "live leases are untouched by recovery");
  assert.equal(claim(db1, "worker-b"), null);
  // Simulate the lease expiring (a real deployment waits it out); then
  // recovery returns the job to pending exactly once, and the old token
  // can never complete it.
  db1.prepare("UPDATE jobs SET lease_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(id);
  assert.equal(recover(db1), 1);
  const reclaimed = claim(db1, "worker-b");
  assert.equal(reclaimed.id, id);
  assert.notEqual(reclaimed.lease_token, child.token);
  assert.throws(() => complete(db1, id, child.token), /fencing token mismatch/);
  complete(db1, id, reclaimed.lease_token, { ok: true });
  assert.equal(getJob(db1, id).status, "done");
});
