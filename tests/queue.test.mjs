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
  fail(db, p, claimed.lease_token, { reason: "synthetic failure" });
  assert.equal(getJob(db, p).status, "failed");
  const c = enqueue(db, "search", {});
  cancelJob(db, c);
  assert.equal(getJob(db, c).status, "cancelled");
});

test("pause and cancel work on claimed jobs; the old token can never complete afterwards", () => {
  const { db } = tmpDb();
  const id = enqueue(db, "search", {});
  const claimed = claim(db, "worker-a");
  pauseJob(db, id);
  assert.equal(getJob(db, id).status, "paused");
  assert.equal(getJob(db, id).lease_token, null, "pausing clears the lease");
  assert.throws(() => complete(db, id, claimed.lease_token), /not claimed/);
  resumeJob(db, id);
  const reclaimed = claim(db, "worker-b");
  cancelJob(db, id);
  assert.equal(getJob(db, id).status, "cancelled");
  assert.throws(() => complete(db, id, reclaimed.lease_token), /not claimed/);
  assert.throws(() => cancelJob(db, id), /only a pending, paused or claimed job can be cancelled/);
});

test("stale token cannot complete a job reclaimed after lease expiry", () => {
  const { db } = tmpDb();
  const id = enqueue(db, "search", {});
  const first = claim(db, "worker-a");
  db.prepare("UPDATE jobs SET lease_expires_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(id);
  assert.equal(recover(db), 1);
  const second = claim(db, "worker-b");
  assert.notEqual(second.lease_token, first.lease_token);
  assert.throws(() => complete(db, id, first.lease_token), /fencing token mismatch/);
  assert.equal(getJob(db, id).status, "claimed", "a stale complete must not change the reclaimed job");
  complete(db, id, second.lease_token, { ok: true });
  assert.equal(getJob(db, id).status, "done");
});

test("concurrent complete race across processes: exactly one winner", async () => {
  const { dbPath } = tmpDb();
  const db0 = openDatabase(dbPath);
  const id = enqueue(db0, "search", {});
  db0.close();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const root = new URL("..", import.meta.url).pathname;
  // Both children hold the same valid token; the atomic UPDATE lets one win.
  const db1 = openDatabase(dbPath);
  const claimed = claim(db1, "worker-a");
  db1.close();
  const results = await Promise.all([
    run(process.execPath, ["tests/helpers/complete-child.mjs", dbPath, id, claimed.lease_token], { cwd: root }),
    run(process.execPath, ["tests/helpers/complete-child.mjs", dbPath, id, claimed.lease_token], { cwd: root }),
  ]);
  const outcomes = results.map((r) => JSON.parse(r.stdout.trim()));
  assert.equal(outcomes.filter((o) => o.ok).length, 1, "exactly one process may complete the job");
  assert.equal(outcomes.filter((o) => !o.ok).length, 1);
  const db2 = openDatabase(dbPath);
  assert.equal(getJob(db2, id).status, "done");
});

test("periodic recovery sweep returns an expired lease to pending without a restart", async () => {
  const { createServer } = await import("../apps/server/server.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-q-sweep-"));
  const { db, stopRecovery } = createServer({ dataDir: dir, recoverIntervalMs: 50 });
  try {
    const id = enqueue(db, "search", {});
    const claimed = claim(db, "worker-a", 100);
    assert.equal(claimed.id, id);
    assert.equal(getJob(db, id).status, "claimed");
    // No recover() call here and no restart: the sweep must do it.
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(getJob(db, id).status, "pending");
    assert.equal(getJob(db, id).lease_token, null);
    const reclaimed = claim(db, "worker-b");
    assert.equal(reclaimed.id, id);
  } finally {
    stopRecovery();
  }
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
