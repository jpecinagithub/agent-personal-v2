// Pliego F3 T-V2-033 (RF-V2-034, RF-V2-039): scheduler behaviour —
// DST ambiguous / skipped local hours, run locking, single
// post-restart recovery, backoff (incl. Retry-After) and budgets.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import {
  nextRunLocal, instantsForLocalTime, claimRunLock, recoverStuckRuns,
  takeRecoveryRun, hasRecoveryPending, recordSourceFailure,
  recordSourceSuccess, isSourceDue, getBackoffState,
  createBudget, budgetAllowsJob, budgetAllowsPage, noteJob, notePage,
  budgetDeadlineExceeded, BACKOFF_BASE_MS, BACKOFF_CAP_MS,
} from "../packages/shared/search-scheduler.mjs";
import { createSearchDefinition } from "../packages/shared/search-run.mjs";

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-scheduler-"));
  return openDatabase(path.join(dir, "agentv2.db"));
}

function definition(over = {}) {
  return {
    name: "Scheduler test",
    profileIds: ["profile-1"],
    titles: { any: ["Finance Manager"], exclude: [] },
    locations: { countries: ["ES"], remoteCountries: ["ES"] },
    workModes: ["remote", "hybrid"],
    sources: ["greenhouse-catalog"],
    schedule: { timezone: "Europe/Madrid", localTimes: ["09:00"], enabled: true },
    action: "save",
    limits: { maxJobs: 100, maxPagesPerSource: 10 },
    ...over,
  };
}

function makeDefinition(db, over = {}) {
  return createSearchDefinition(db, definition(over));
}

test("scheduler: next slot today, then tomorrow, disabled schedule returns null", () => {
  const def = definition();
  const next = nextRunLocal(def, "2026-10-28T07:00:00Z");
  assert.equal(next.localKey, "2026-10-28T09:00");
  assert.equal(next.runAt, "2026-10-28T08:00:00.000Z"); // CET (UTC+1) in late October
  const after = nextRunLocal(def, "2026-10-28T09:00:00Z");
  assert.equal(after.localKey, "2026-10-29T09:00");
  assert.equal(nextRunLocal(definition({ schedule: { timezone: "Europe/Madrid", localTimes: ["09:00"], enabled: false } }), "2026-10-28T07:00:00Z"), null);
});

test("scheduler: DST fall-back — the ambiguous 02:30 hour runs at most once per local key", () => {
  // Europe/Madrid, 2026-10-25: clocks go back 03:00 CEST -> 02:00 CET,
  // so local 02:30 occurs twice: 00:30Z (CEST) and 01:30Z (CET).
  const def = definition({ schedule: { timezone: "Europe/Madrid", localTimes: ["02:30"], enabled: true } });
  const instants = instantsForLocalTime("2026-10-25", "02:30", "Europe/Madrid");
  assert.deepEqual(instants.map((ms) => new Date(ms).toISOString()), ["2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"]);
  const first = nextRunLocal(def, "2026-10-25T00:00:00Z");
  assert.equal(first.runAt, "2026-10-25T00:30:00.000Z");
  assert.equal(first.localKey, "2026-10-25T02:30");
  // After that slot ran, the second occurrence of the SAME local key
  // must be skipped even though it is still in the future.
  const afterRun = nextRunLocal(def, "2026-10-25T00:45:00Z", "2026-10-25T02:30");
  assert.equal(afterRun.localKey, "2026-10-26T02:30");
  assert.notEqual(afterRun.runAt, "2026-10-25T01:30:00.000Z");
  // Without a lastRunKey, the second occurrence is still a valid
  // future slot (nothing ran yet).
  const second = nextRunLocal(def, "2026-10-25T00:45:00Z");
  assert.equal(second.runAt, "2026-10-25T01:30:00.000Z");
});

test("scheduler: DST spring-forward — a local time in the gap is skipped, never invented", () => {
  // 2026-03-29: clocks jump 02:00 -> 03:00 CET -> CEST; 02:30 never occurs.
  const def = definition({ schedule: { timezone: "Europe/Madrid", localTimes: ["02:30"], enabled: true } });
  assert.deepEqual(instantsForLocalTime("2026-03-29", "02:30", "Europe/Madrid"), []);
  const next = nextRunLocal(def, "2026-03-29T00:00:00Z");
  assert.equal(next.localKey, "2026-03-30T02:30");
  assert.equal(next.runAt, "2026-03-30T00:30:00.000Z"); // CEST (UTC+2)
});

test("scheduler: a second claim while one run is running is locked and creates nothing", () => {
  const db = tempDb();
  const def = makeDefinition(db);
  const first = claimRunLock(db, def.id, def.criteria);
  assert.equal(first.locked, false);
  assert.ok(first.runId);
  const second = claimRunLock(db, def.id, def.criteria);
  assert.equal(second.locked, true);
  assert.equal(second.runId, first.runId);
  const running = db.prepare("SELECT COUNT(*) AS n FROM search_runs WHERE definition_id = ? AND status = 'running'").get(def.id);
  assert.equal(running.n, 1);
});

test("scheduler: recovery marks stuck runs interrupted and allows exactly one catch-up", () => {
  const db = tempDb();
  const def = makeDefinition(db);
  const claim = claimRunLock(db, def.id, def.criteria);
  assert.equal(hasRecoveryPending(db, def.id), false);
  const recovered = recoverStuckRuns(db);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].runId, claim.runId);
  assert.equal(recovered[0].recoveryPending, true);
  const run = db.prepare("SELECT status FROM search_runs WHERE id = ?").get(claim.runId);
  assert.equal(run.status, "interrupted");
  assert.equal(hasRecoveryPending(db, def.id), true);
  assert.equal(takeRecoveryRun(db, def.id), true);
  assert.equal(takeRecoveryRun(db, def.id), false);
  assert.equal(hasRecoveryPending(db, def.id), false);
  // A second recovery sweep with nothing stuck raises no new flag.
  assert.deepEqual(recoverStuckRuns(db), []);
  assert.equal(takeRecoveryRun(db, def.id), false);
});

test("scheduler: backoff honours Retry-After exactly, otherwise doubles up to the cap", () => {
  const db = tempDb();
  const def = makeDefinition(db);
  const now = new Date("2026-10-28T10:00:00Z");
  const withRetry = recordSourceFailure(db, def.id, "greenhouse-catalog", { retryAfterMs: 5000, now });
  assert.equal(withRetry.nextAttemptAt, "2026-10-28T10:00:05.000Z");
  assert.equal(isSourceDue(db, def.id, "greenhouse-catalog", "2026-10-28T10:00:04Z"), false);
  assert.equal(isSourceDue(db, def.id, "greenhouse-catalog", "2026-10-28T10:00:05Z"), true);
  assert.equal(recordSourceSuccess(db, def.id, "greenhouse-catalog"), true);
  assert.equal(isSourceDue(db, def.id, "greenhouse-catalog", now), true);
  // Exponential without Retry-After: 60 s, 120 s, ... capped at 24 h.
  let last;
  for (let i = 0; i < 12; i += 1) {
    last = recordSourceFailure(db, def.id, "ashby-catalog", { now });
  }
  assert.ok(Date.parse(last.nextAttemptAt) - now.getTime() <= BACKOFF_CAP_MS);
  assert.ok(Date.parse(last.nextAttemptAt) - now.getTime() >= BACKOFF_BASE_MS);
  const state = getBackoffState(db, def.id);
  assert.equal(state["ashby-catalog"].failures, 12);
});

test("scheduler: budget caps jobs, pages per source and the deadline", () => {
  const budget = createBudget({ maxJobs: 2, maxPagesPerSource: 1 }, { deadlineMs: 1000, nowMs: 100000 });
  assert.equal(budgetAllowsJob(budget, 100000), true);
  assert.equal(budgetAllowsPage(budget, "greenhouse-catalog", 100000), true);
  notePage(budget, "greenhouse-catalog");
  assert.equal(budgetAllowsPage(budget, "greenhouse-catalog", 100000), false);
  assert.equal(budgetAllowsPage(budget, "lever-catalog", 100000), true);
  noteJob(budget);
  assert.equal(budgetAllowsJob(budget, 100000), true);
  noteJob(budget);
  assert.equal(budgetAllowsJob(budget, 100000), false);
  assert.equal(budgetDeadlineExceeded(budget, 100000), false);
  assert.equal(budgetDeadlineExceeded(budget, 101001), true);
  assert.equal(budgetAllowsJob(budget, 101001), false);
});
