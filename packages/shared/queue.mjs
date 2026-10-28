// T-V2-011: durable queue with leases and fencing tokens.
// Claim is atomic (single UPDATE). Completing or failing is also a
// single UPDATE conditioned on id + fencing token + live lease + claimed
// status, so no separate token check can race with another process: the
// UPDATE itself is the decision, and exactly one writer wins.
// Pause and cancel also work on claimed jobs (lease cleared); a job that
// is done, failed or cancelled can never be completed with an old token.
// Restart recovery returns expired leases to pending exactly once; the
// server additionally runs recover() on a periodic sweep so a lease that
// expires after a restart is recovered without another restart.
import { randomUUID } from "node:crypto";

const nowIso = () => new Date().toISOString();

export function enqueue(db, kind, payload = {}) {
  const id = randomUUID();
  db.prepare("INSERT INTO jobs (id, kind, payload_json) VALUES (?, ?, ?)").run(id, kind, JSON.stringify(payload));
  return id;
}

export function claim(db, workerId, leaseMs = 60000) {
  const token = randomUUID();
  const expires = new Date(Date.now() + leaseMs).toISOString();
  const job = db.prepare(
    "UPDATE jobs SET status = 'claimed', lease_owner = ?, lease_token = ?, lease_expires_at = ?, attempts = attempts + 1, updated_at = ? " +
    "WHERE id = (SELECT id FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1) " +
    "RETURNING *",
  ).get(workerId, token, expires, nowIso());
  return job ?? null;
}

// Single atomic transition to a terminal state, conditioned on the fence.
// If the UPDATE touches nothing, re-read only to explain why; the outcome
// was decided by the UPDATE, not by the re-read.
function finishAtomic(db, jobId, token, status, result) {
  const now = nowIso();
  const r = db.prepare(
    "UPDATE jobs SET status = ?, result_json = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? " +
    "WHERE id = ? AND status = 'claimed' AND lease_token = ? AND (lease_expires_at IS NULL OR lease_expires_at > ?)",
  ).run(status, JSON.stringify(result), now, jobId, token, now);
  if (r.changes === 1) return;
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw new Error("job not found");
  if (job.status !== "claimed") throw new Error("job is not claimed");
  if (job.lease_token !== token) throw new Error("fencing token mismatch: stale worker cannot complete this job");
  throw new Error("lease expired");
}

export function complete(db, jobId, token, result = {}) {
  finishAtomic(db, jobId, token, "done", result);
}

export function fail(db, jobId, token, result = {}) {
  finishAtomic(db, jobId, token, "failed", result);
}

// Pausing a claimed job clears its lease, so the work is not stranded
// with a dead worker; resuming returns it to pending for a fresh claim.
export function pauseJob(db, jobId) {
  const r = db.prepare("UPDATE jobs SET status = 'paused', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'claimed')").run(nowIso(), jobId);
  if (r.changes === 0) throw new Error("only a pending or claimed job can be paused");
}

export function resumeJob(db, jobId) {
  const r = db.prepare("UPDATE jobs SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'paused'").run(nowIso(), jobId);
  if (r.changes === 0) throw new Error("only a paused job can be resumed");
}

// Cancelling a claimed job is terminal and clears the lease, so the old
// token can never complete it afterwards (finishAtomic requires claimed).
export function cancelJob(db, jobId) {
  const r = db.prepare("UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'paused', 'claimed')").run(nowIso(), jobId);
  if (r.changes === 0) throw new Error("only a pending, paused or claimed job can be cancelled");
}

// Recovery: expired leases return to pending, lease cleared.
// Jobs with a live lease are untouched, so reopening never duplicates work.
export function recover(db) {
  const r = db.prepare("UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?").run(nowIso(), nowIso());
  return r.changes;
}

export function getJob(db, jobId) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
}
