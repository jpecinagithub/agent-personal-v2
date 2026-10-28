// T-V2-011: durable queue with leases and fencing tokens.
// A claim is atomic (single UPDATE inside a transaction). Completing or
// failing requires the exact fencing token and a live lease; a stale token
// can never finish someone else's work. Restart recovery returns expired
// leases to pending exactly once.
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

function checkFence(db, jobId, token) {
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  if (!job) throw new Error("job not found");
  if (job.status !== "claimed") throw new Error("job is not claimed");
  if (job.lease_token !== token) throw new Error("fencing token mismatch: stale worker cannot complete this job");
  if (job.lease_expires_at && new Date(job.lease_expires_at) <= new Date()) throw new Error("lease expired");
  return job;
}

export function complete(db, jobId, token, result = {}) {
  checkFence(db, jobId, token);
  db.prepare("UPDATE jobs SET status = 'done', result_json = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(result), nowIso(), jobId);
}

export function fail(db, jobId, token, result = {}) {
  checkFence(db, jobId, token);
  db.prepare("UPDATE jobs SET status = 'failed', result_json = ?, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(result), nowIso(), jobId);
}

export function pauseJob(db, jobId) {
  const r = db.prepare("UPDATE jobs SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'pending'").run(nowIso(), jobId);
  if (r.changes === 0) throw new Error("only a pending job can be paused");
}

export function resumeJob(db, jobId) {
  const r = db.prepare("UPDATE jobs SET status = 'pending', updated_at = ? WHERE id = ? AND status = 'paused'").run(nowIso(), jobId);
  if (r.changes === 0) throw new Error("only a paused job can be resumed");
}

export function cancelJob(db, jobId) {
  const r = db.prepare("UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status IN ('pending', 'paused')").run(nowIso(), jobId);
  if (r.changes === 0) throw new Error("only a pending or paused job can be cancelled");
}

// Restart recovery: expired leases return to pending, lease cleared.
// Jobs with a live lease are untouched, so reopening never duplicates work.
export function recover(db) {
  const r = db.prepare("UPDATE jobs SET status = 'pending', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'claimed' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?").run(nowIso(), nowIso());
  return r.changes;
}

export function getJob(db, jobId) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
}
