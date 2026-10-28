// Pliego F3 T-V2-033 (RF-V2-034, RF-V2-039): the search scheduler.
//
// Rules enforced here, from design doc 03 §9:
// - One run per definition at a time: claimRunLock() creates the
//   "running" run row inside a transaction; a second claim while one
//   is running returns { locked: true } and creates NOTHING.
// - DST: nextRunLocal() computes the next scheduled LOCAL time in
//   the definition's timezone with Intl. A local time that occurs
//   twice (Europe/Madrid fall-back, e.g. 02:30 on 2026-10-25) is
//   keyed by its local date+time string; once a slot with that key
//   has run (lastRunKey), the second occurrence of the same key is
//   skipped, so the ambiguous hour runs at most once. A local time
//   that does not occur at all (spring-forward gap, e.g. 02:30 on
//   2026-03-29) is skipped for that day, never invented.
// - Recovery: recoverStuckRuns() marks runs still "running" after a
//   restart as "interrupted" and raises ONE recovery flag per
//   definition. It never re-runs anything itself, and
//   takeRecoveryRun() can be consumed exactly once: catch-up is at
//   most one recovery run per definition, never all missed slots.
// - Backoff: per source. A Retry-After value is honoured exactly
//   (nextAttemptAt = now + retryAfterMs); otherwise backoff doubles
//   from a 60 s base and is capped at 24 h. A success clears it.
// - Budget: pure helpers (createBudget / budgetAllows* / note*) cap
//   total jobs, pages per source and the run deadline.
import { randomUUID } from "node:crypto";

export const BACKOFF_BASE_MS = 60000;
export const BACKOFF_CAP_MS = 86400000;
export const BACKOFF_FACTOR = 2;
export const DEFAULT_RUN_DEADLINE_MS = 120000;

// ------------------------------------------------------------------
// Timezone arithmetic (Intl only, no dependency).
// ------------------------------------------------------------------

const formatters = new Map();

/** @param {string} timeZone */
function formatterFor(timeZone) {
  if (!formatters.has(timeZone)) {
    // Throws RangeError on an unknown timezone: a bad schedule is a
    // caller error, never silently computed in another zone.
    formatters.set(timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }));
  }
  return formatters.get(timeZone);
}

/**
 * Local wall-clock parts of an instant in a timezone.
 * @param {Date | number | string} date
 * @param {string} timeZone
 * @returns {{date: string, time: string, year: number, month: number, day: number, hour: number, minute: number}}
 */
export function localParts(date, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(date));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return {
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    year, month, day, hour, minute,
  };
}

/** Offset (ms) of a timezone at an instant: local-wall-as-UTC minus the instant. @param {string} timeZone @param {number} utcMs */
function timezoneOffsetMs(timeZone, utcMs) {
  const floored = Math.floor(utcMs / 1000) * 1000;
  const p = localParts(floored, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - floored;
}

/**
 * Every instant (0, 1 or 2) whose local wall clock in `timeZone`
 * equals `date` + `time`. Two instants means an ambiguous hour
 * (fall-back); zero means a skipped hour (spring-forward gap).
 * @param {string} date YYYY-MM-DD
 * @param {string} time HH:MM
 * @param {string} timeZone
 * @returns {number[]}
 */
export function instantsForLocalTime(date, time, timeZone) {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const base = Date.UTC(y, m - 1, d, hh, mm);
  const candidate = base - timezoneOffsetMs(timeZone, base);
  const found = [];
  for (const delta of [-3600000, 0, 3600000]) {
    const instant = candidate + delta;
    const p = localParts(instant, timeZone);
    if (p.date === date && p.time === time) found.push(instant);
  }
  return [...new Set(found)].sort((a, b) => a - b);
}

/** @param {string} date YYYY-MM-DD @param {number} days */
function addDays(date, days) {
  const [y, m, d] = date.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

/**
 * The next scheduled run for a definition, or null when its schedule
 * is disabled. `lastRunKey` is the local date+time key of the slot
 * that already ran (see search_scheduler_state.last_run_key): any
 * candidate with that key is skipped, which is what keeps an
 * ambiguous local hour to at most one run.
 * @param {any} definition validated search definition (schedule: {timezone, localTimes, enabled})
 * @param {Date | number | string} [now]
 * @param {string | null} [lastRunKey]
 * @returns {{runAt: string, localKey: string, localDate: string, localTime: string, timezone: string} | null}
 */
export function nextRunLocal(definition, now = new Date(), lastRunKey = null) {
  const schedule = definition?.schedule ?? {};
  if (schedule.enabled === false) return null;
  const timeZone = schedule.timezone;
  if (typeof timeZone !== "string" || !timeZone) throw new Error("schedule.timezone is required");
  const localTimes = [...(schedule.localTimes ?? [])].sort();
  if (localTimes.length === 0) throw new Error("schedule.localTimes must not be empty");
  const nowMs = new Date(now).getTime();
  if (Number.isNaN(nowMs)) throw new Error("invalid now");
  const today = localParts(nowMs, timeZone).date;
  for (let dayOffset = 0; dayOffset <= 10; dayOffset += 1) {
    const date = addDays(today, dayOffset);
    for (const time of localTimes) {
      for (const instant of instantsForLocalTime(date, time, timeZone)) {
        const localKey = `${date}T${time}`;
        if (instant >= nowMs && localKey !== lastRunKey) {
          return { runAt: new Date(instant).toISOString(), localKey, localDate: date, localTime: time, timezone: timeZone };
        }
      }
    }
  }
  return null;
}

// ------------------------------------------------------------------
// Scheduler state (search_scheduler_state) and run locking.
// ------------------------------------------------------------------

function ensureSchedulerTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS search_scheduler_state (
    definition_id TEXT PRIMARY KEY, last_run_key TEXT,
    recovery_pending INTEGER NOT NULL DEFAULT 0,
    backoff_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )`);
}

/** @param {any} db @param {string} definitionId */
export function getSchedulerState(db, definitionId) {
  ensureSchedulerTable(db);
  const row = db.prepare("SELECT * FROM search_scheduler_state WHERE definition_id = ?").get(definitionId);
  if (!row) return { definitionId, lastRunKey: null, recoveryPending: false, backoff: {} };
  let backoff = {};
  try { backoff = JSON.parse(row.backoff_json ?? "{}"); } catch { backoff = {}; }
  return {
    definitionId,
    lastRunKey: row.last_run_key ?? null,
    recoveryPending: row.recovery_pending === 1,
    backoff,
  };
}

/** @param {any} db @param {string} definitionId @param {any} patch */
function upsertSchedulerState(db, definitionId, patch) {
  ensureSchedulerTable(db);
  const current = getSchedulerState(db, definitionId);
  const next = { ...current, ...patch };
  db.prepare(`INSERT INTO search_scheduler_state (definition_id, last_run_key, recovery_pending, backoff_json, updated_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(definition_id) DO UPDATE SET last_run_key = excluded.last_run_key,
      recovery_pending = excluded.recovery_pending, backoff_json = excluded.backoff_json,
      updated_at = excluded.updated_at`).run(
    definitionId, next.lastRunKey ?? null, next.recoveryPending ? 1 : 0, JSON.stringify(next.backoff ?? {}),
  );
  return next;
}

/** Record that the local slot `localKey` ran for a definition. @param {any} db @param {string} definitionId @param {string} localKey */
export function markSlotRun(db, definitionId, localKey) {
  return upsertSchedulerState(db, definitionId, { lastRunKey: localKey });
}

/**
 * Claim the run lock for a definition: creates a "running" run row.
 * A second claim while one is running returns { locked: true } and
 * creates nothing (no duplicate run, no duplicate work).
 * @param {any} db
 * @param {string} definitionId
 * @param {any} [criteriaSnapshot]
 * @returns {{locked: boolean, runId: string | null}}
 */
export function claimRunLock(db, definitionId, criteriaSnapshot = {}) {
  const definition = db.prepare("SELECT id FROM search_definitions WHERE id = ?").get(definitionId);
  if (!definition) throw new Error("search definition not found");
  db.exec("BEGIN IMMEDIATE");
  try {
    const running = db.prepare("SELECT id FROM search_runs WHERE definition_id = ? AND status = 'running' ORDER BY started_at ASC LIMIT 1").get(definitionId);
    if (running) {
      db.exec("ROLLBACK");
      return { locked: true, runId: running.id };
    }
    const runId = randomUUID();
    db.prepare("INSERT INTO search_runs (id, definition_id, status, criteria_snapshot_json) VALUES (?, ?, 'running', ?)").run(
      runId, definitionId, JSON.stringify(criteriaSnapshot ?? {}),
    );
    db.exec("COMMIT");
    return { locked: false, runId };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * Mark every still-"running" run as "interrupted" (a restart means
 * the worker is gone; the run did not finish) and raise exactly one
 * recovery flag per affected definition. Nothing is re-run here:
 * callers decide whether to consume the single recovery run via
 * takeRecoveryRun(). Returns one entry per interrupted run.
 * @param {any} db
 * @param {Date | number | string} [now]
 * @returns {{runId: string, definitionId: string, recoveryPending: boolean}[]}
 */
export function recoverStuckRuns(db, now = new Date()) {
  ensureSchedulerTable(db);
  const stuck = db.prepare("SELECT id, definition_id FROM search_runs WHERE status = 'running' ORDER BY started_at ASC").all();
  const finishedAt = new Date(now).toISOString();
  const out = [];
  for (const run of stuck) {
    db.prepare("UPDATE search_runs SET status = 'interrupted', finished_at = ? WHERE id = ? AND status = 'running'").run(finishedAt, run.id);
    upsertSchedulerState(db, run.definition_id, { recoveryPending: true });
    out.push({ runId: run.id, definitionId: run.definition_id, recoveryPending: true });
  }
  return out;
}

/**
 * Consume the single post-restart recovery slot for a definition:
 * true exactly once after recoverStuckRuns() raised the flag, then
 * false until another restart raises it again.
 * @param {any} db @param {string} definitionId
 */
export function takeRecoveryRun(db, definitionId) {
  const state = getSchedulerState(db, definitionId);
  if (!state.recoveryPending) return false;
  upsertSchedulerState(db, definitionId, { recoveryPending: false });
  return true;
}

/** @param {any} db @param {string} definitionId */
export function hasRecoveryPending(db, definitionId) {
  return getSchedulerState(db, definitionId).recoveryPending;
}

// ------------------------------------------------------------------
// Backoff, per source.
// ------------------------------------------------------------------

/**
 * Record a source failure. Retry-After is honoured exactly;
 * otherwise the delay doubles from BACKOFF_BASE_MS per consecutive
 * failure, capped at BACKOFF_CAP_MS.
 * @param {any} db @param {string} definitionId @param {string} source
 * @param {{retryAfterMs?: number | null, now?: Date | number | string}} [opts]
 * @returns {{source: string, failures: number, nextAttemptAt: string}}
 */
export function recordSourceFailure(db, definitionId, source, { retryAfterMs = null, now = new Date() } = {}) {
  const state = getSchedulerState(db, definitionId);
  const previous = state.backoff[source] ?? { failures: 0, nextAttemptAt: null };
  const failures = (previous.failures ?? 0) + 1;
  const nowMs = new Date(now).getTime();
  const delay = typeof retryAfterMs === "number" && retryAfterMs >= 0
    ? retryAfterMs
    : Math.min(BACKOFF_BASE_MS * (BACKOFF_FACTOR ** (failures - 1)), BACKOFF_CAP_MS);
  const entry = { failures, nextAttemptAt: new Date(nowMs + delay).toISOString(), retryAfterMs: retryAfterMs ?? null };
  const backoff = { ...state.backoff, [source]: entry };
  upsertSchedulerState(db, definitionId, { backoff });
  return { source, failures, nextAttemptAt: entry.nextAttemptAt };
}

/** Clear a source's backoff after a success. @param {any} db @param {string} definitionId @param {string} source */
export function recordSourceSuccess(db, definitionId, source) {
  const state = getSchedulerState(db, definitionId);
  const backoff = { ...state.backoff };
  delete backoff[source];
  upsertSchedulerState(db, definitionId, { backoff });
  return true;
}

/** True when a source may be attempted now (no backoff, or it expired). @param {any} db @param {string} definitionId @param {string} source @param {Date | number | string} [now] */
export function isSourceDue(db, definitionId, source, now = new Date()) {
  const state = getSchedulerState(db, definitionId);
  const entry = state.backoff[source];
  if (!entry || !entry.nextAttemptAt) return true;
  return new Date(now).getTime() >= Date.parse(entry.nextAttemptAt);
}

/** @param {any} db @param {string} definitionId @returns {Record<string, any>} */
export function getBackoffState(db, definitionId) {
  return getSchedulerState(db, definitionId).backoff;
}

// ------------------------------------------------------------------
// Budget (pure helpers; no database).
// ------------------------------------------------------------------

/**
 * @param {any} limits {maxJobs, maxPagesPerSource, deadlineMs?}
 * @param {{deadlineMs?: number, nowMs?: number}} [opts]
 */
export function createBudget(limits, { deadlineMs = undefined, nowMs = Date.now() } = {}) {
  const maxJobs = limits?.maxJobs ?? Number.POSITIVE_INFINITY;
  const maxPagesPerSource = limits?.maxPagesPerSource ?? Number.POSITIVE_INFINITY;
  const deadline = nowMs + (deadlineMs ?? limits?.deadlineMs ?? DEFAULT_RUN_DEADLINE_MS);
  return { maxJobs, maxPagesPerSource, deadlineMs: deadline, startedAtMs: nowMs, jobsUsed: 0, pagesUsedBySource: {}, truncated: false };
}

/** @param {any} budget @param {Date | number | string} [now] */
export function budgetDeadlineExceeded(budget, now = Date.now()) {
  return new Date(now).getTime() > budget.deadlineMs;
}

/** @param {any} budget @param {Date | number | string} [now] */
export function budgetAllowsJob(budget, now = Date.now()) {
  return !budgetDeadlineExceeded(budget, now) && budget.jobsUsed < budget.maxJobs;
}

/** @param {any} budget @param {string} source @param {Date | number | string} [now] */
export function budgetAllowsPage(budget, source, now = Date.now()) {
  return !budgetDeadlineExceeded(budget, now) && (budget.pagesUsedBySource[source] ?? 0) < budget.maxPagesPerSource;
}

/** @param {any} budget */
export function noteJob(budget) {
  budget.jobsUsed += 1;
  if (budget.jobsUsed >= budget.maxJobs) budget.truncated = true;
  return budget;
}

/** @param {any} budget @param {string} source */
export function notePage(budget, source) {
  budget.pagesUsedBySource[source] = (budget.pagesUsedBySource[source] ?? 0) + 1;
  if (budget.pagesUsedBySource[source] >= budget.maxPagesPerSource) budget.truncated = true;
  return budget;
}
