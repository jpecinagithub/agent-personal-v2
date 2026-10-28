// Pliego T-V2-020 (profiles) and T-V2-021 (snapshots and versions).
// The limit is TEN NON-DELETED profiles: archived profiles still occupy
// a slot; only deleted profiles are excluded from the count. Deleting a
// profile is a soft delete: the row stays, its snapshots are never
// deleted, and attempts referencing those snapshots keep resolving.
// Profiles share one declared-facts repository: the profile body holds
// fact REFERENCES ({concept, scope} pairs), never copies of fact
// values. Sending pins the snapshot in force at that moment AND a
// snapshot of the whole person (identity, contacts, employment and
// education history); later edits never alter a past attempt.
import { randomUUID } from "node:crypto";
import { getConfirmedFact } from "./facts.mjs";
import { getPerson } from "./person.mjs";
import { hasValidatedCv } from "./cv.mjs";
import { requiredPoliciesAccepted, hasConsent } from "./policies.mjs";

export const MAX_PROFILES = 10;

const ALLOWED_BODY_KEYS = new Set([
  "focus", "template", "factRefs", "desired_roles", "locations",
  "salary_expectations", "notes",
]);

/** Validate a profile body: unknown keys are rejected, factRefs must be concept/scope pairs. */
export function validateProfileBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("profile body must be an object");
  for (const key of Object.keys(body)) {
    if (!ALLOWED_BODY_KEYS.has(key)) throw new Error(`unknown profile field: ${key}`);
  }
  if (body.factRefs !== undefined) {
    if (!Array.isArray(body.factRefs)) throw new Error("factRefs must be an array");
    for (const r of body.factRefs) {
      if (!r || typeof r.concept !== "string" || r.concept.trim() === "") throw new Error("each factRef needs a concept");
      if (r.scope !== undefined && typeof r.scope !== "string") throw new Error("factRef scope must be a string");
    }
  }
  return { ...body };
}

/** Non-deleted profiles (active + archived) occupy a slot; deleted ones do not. */
export function countNonDeletedProfiles(db, personId) {
  return db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE person_id = ? AND deleted = 0").get(personId).n;
}

/** Backwards-compatible alias for the old name, with the corrected semantics. */
export const countActiveProfiles = countNonDeletedProfiles;

export function createProfileFull(db, personId, name, body = {}) {
  if (typeof name !== "string" || name.trim() === "") throw new Error("profile name is required");
  if (!db.prepare("SELECT id FROM persons WHERE id = ?").get(personId)) throw new Error("person not found");
  if (countNonDeletedProfiles(db, personId) >= MAX_PROFILES) {
    throw new Error(`profile limit reached: at most ${MAX_PROFILES} non-deleted profiles per person`);
  }
  const valid = validateProfileBody(body);
  const id = randomUUID();
  db.prepare("INSERT INTO profiles (id, person_id, name, focus, template, body_json) VALUES (?, ?, ?, ?, ?, ?)").run(
    id, personId, name.trim(), valid.focus ?? "", valid.template ?? "", JSON.stringify(valid),
  );
  return id;
}

/**
 * @param {any} db
 * @param {string} personId
 * @param {{includeDeleted?: boolean}} [opts]
 * @returns {any[]}
 */
export function listProfiles(db, personId, opts = {}) {
  const where = opts.includeDeleted ? "person_id = ?" : "person_id = ? AND deleted = 0";
  return db.prepare(`SELECT * FROM profiles WHERE ${where} ORDER BY created_at ASC`).all(personId).map((/** @type {any} */ r) => ({
    ...r, body: JSON.parse(r.body_json), archived: r.archived === 1, deleted: r.deleted === 1,
  }));
}

export function getProfileFull(db, profileId) {
  const row = db.prepare("SELECT * FROM profiles WHERE id = ?").get(profileId);
  if (!row) return null;
  return { ...row, body: JSON.parse(row.body_json), archived: row.archived === 1, deleted: row.deleted === 1 };
}

function requireLiveProfile(db, profileId) {
  const profile = getProfileFull(db, profileId);
  if (!profile) throw new Error("profile not found");
  if (profile.deleted) throw new Error("profile is deleted");
  return profile;
}

export function archiveProfile(db, profileId) {
  requireLiveProfile(db, profileId);
  const r = db.prepare("UPDATE profiles SET archived = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND archived = 0").run(profileId);
  if (r.changes === 0) throw new Error("profile not found or already archived");
}

export function unarchiveProfile(db, profileId) {
  // No limit check here on purpose: an archived profile already occupies
  // a non-deleted slot, so unarchiving cannot exceed the limit.
  requireLiveProfile(db, profileId);
  db.prepare("UPDATE profiles SET archived = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(profileId);
}

/**
 * Duplicate a profile: a new profile with the same body, focus and
 * template. It counts toward the ten non-deleted limit like any other.
 * @param {any} db
 * @param {string} profileId
 * @param {string} [name]
 * @returns {string}
 */
export function duplicateProfile(db, profileId, name) {
  const source = requireLiveProfile(db, profileId);
  return createProfileFull(db, source.person_id, name ?? `${source.name} (copia)`, source.body);
}

/**
 * Soft delete: only an archived profile can be deleted, and deletion
 * marks it deleted without touching its snapshots or drafts, so past
 * attempts keep resolving.
 * @param {any} db
 * @param {string} profileId
 */
export function deleteProfile(db, profileId) {
  const profile = getProfileFull(db, profileId);
  if (!profile) throw new Error("profile not found");
  if (profile.deleted) throw new Error("profile is already deleted");
  if (!profile.archived) throw new Error("only an archived profile can be deleted");
  db.prepare("UPDATE profiles SET deleted = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(profileId);
}

/** The snapshot in force: the stored snapshot for the current version, or a new one pinning the current body. */
export function pinSnapshot(db, profileId) {
  const profile = getProfileFull(db, profileId);
  if (!profile) throw new Error("profile not found");
  const existing = db.prepare("SELECT * FROM profile_snapshots WHERE profile_id = ? AND version = ?").get(profileId, profile.version);
  if (existing) return existing.id;
  const id = randomUUID();
  db.prepare("INSERT INTO profile_snapshots (id, profile_id, version, body_json) VALUES (?, ?, ?, ?)").run(id, profileId, profile.version, JSON.stringify(profile.body));
  return id;
}

/**
 * Snapshot the whole person as of now: identity, contacts and
 * employment/education history, as one stored copy.
 * @param {any} db
 * @param {string} personId
 * @returns {string}
 */
export function snapshotPerson(db, personId) {
  const person = getPerson(db, personId);
  if (!person) throw new Error("person not found");
  const id = randomUUID();
  db.prepare("INSERT INTO person_snapshots (id, person_id, details_json) VALUES (?, ?, ?)").run(
    id, personId, JSON.stringify(person.details ?? {}),
  );
  return id;
}

/**
 * Readiness (RF-V2-020): a profile is ready only when ALL of these
 * hold — identity declared, name, focus, every referenced fact
 * confirmed, a validated (imported and confirmed) CV, every required
 * policy accepted, the apply-on-behalf consent recorded, and xAI
 * available. The returned `missing` list is the explained block, never
 * a silent pass. Pass { xaiAvailable } from the server, which knows
 * whether the key is in the secret store or the environment; the
 * default (false) blocks readiness rather than assuming xAI.
 * @param {any} db
 * @param {string} profileId
 * @param {{xaiAvailable?: boolean}} [opts]
 * @returns {{ready: boolean, missing: string[]}}
 */
export function profileReadiness(db, profileId, opts = {}) {
  const profile = getProfileFull(db, profileId);
  if (!profile) throw new Error("profile not found");
  const missing = [];
  const person = getPerson(db, profile.person_id);
  const details = person?.details ?? {};
  if (!person || !details.full_name || !String(details.full_name).trim() || (!details.email && !details.phone)) {
    missing.push("identity");
  }
  if (!profile.name.trim()) missing.push("name");
  if (!profile.body.focus || !String(profile.body.focus).trim()) missing.push("focus");
  for (const ref of profile.body.factRefs ?? []) {
    if (!getConfirmedFact(db, profile.person_id, ref.concept, ref.scope ?? "")) {
      missing.push(`fact ${ref.concept}${ref.scope ? ` (${ref.scope})` : ""}`);
    }
  }
  if (!hasValidatedCv(db, profile.person_id)) missing.push("cv_validated");
  if (!requiredPoliciesAccepted(db, profile.person_id)) missing.push("policy");
  if (!hasConsent(db, profile.person_id, "apply_on_behalf")) missing.push("consent");
  if (!opts.xaiAvailable) missing.push("xai");
  return { ready: missing.length === 0, missing };
}

/**
 * Create a send attempt pinning the profile snapshot in force AND a
 * snapshot of the whole person, in one transaction, and storing the
 * resolved fact content on the attempt. Later person, profile or fact
 * changes never rewrite this stored content.
 * @param {any} db
 * @param {string} personId
 * @param {string} profileId
 * @param {string} offerId
 * @param {{xaiAvailable?: boolean}} [opts]
 * @returns {string}
 */
export function createAttempt(db, personId, profileId, offerId, opts = {}) {
  const readiness = profileReadiness(db, profileId, opts);
  if (!readiness.ready) throw new Error(`profile is not ready: missing ${readiness.missing.join(", ")}`);
  const profile = getProfileFull(db, profileId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const snapshotId = pinSnapshot(db, profileId);
    const personSnapshotId = snapshotPerson(db, personId);
    const resolved = {};
    for (const ref of profile.body.factRefs ?? []) {
      const fact = getConfirmedFact(db, personId, ref.concept, ref.scope ?? "");
      if (fact) resolved[`${ref.concept}@${ref.scope ?? ""}`] = fact.value;
    }
    const id = randomUUID();
    db.prepare(
      "INSERT INTO attempts (id, person_id, profile_id, profile_snapshot_id, person_snapshot_id, offer_id, status, evidence_json) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?)",
    ).run(id, personId, profileId, snapshotId, personSnapshotId, offerId, JSON.stringify({ snapshotVersion: profile.version, resolvedFacts: resolved }));
    db.exec("COMMIT");
    return id;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

export function getAttempt(db, attemptId) {
  const row = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
  if (!row) return null;
  const attempt = { ...row, evidence: JSON.parse(row.evidence_json) };
  if (row.person_snapshot_id) {
    const snap = db.prepare("SELECT * FROM person_snapshots WHERE id = ?").get(row.person_snapshot_id);
    attempt.personSnapshot = snap ? JSON.parse(snap.details_json) : null;
  } else {
    attempt.personSnapshot = null;
  }
  return attempt;
}
