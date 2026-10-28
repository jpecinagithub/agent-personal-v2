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
import { getValidatedCvImport, getProfileCvImport, getCvImport } from "./cv.mjs";
import { requiredPoliciesAccepted, hasConsent } from "./policies.mjs";

export const MAX_PROFILES = 10;

const ALLOWED_BODY_KEYS = new Set([
  "focus", "template", "factRefs", "desired_roles", "locations",
  "salary_expectations", "skills", "exclusions",
  "employment_ids", "education_ids", "notes", "cv_import_id",
]);

// User-approved redesign 2026-10-28 (post-G2): the person holds the
// UNIVERSAL data and the MASTER employment/education history, while
// each profile holds its own presentation of that history. A profile
// body may therefore carry per-profile desired_roles, locations,
// skills, exclusions and salary_expectations, plus employment_ids /
// education_ids selecting which master-history entries the profile
// presents. Selection semantics (see presentedHistory below):
//   - key ABSENT  -> the profile presents ALL master entries
//     (backward compatible: profiles created before selections existed
//     behave exactly as before);
//   - key present and EMPTY -> the profile presents NONE;
//   - key present with ids -> exactly those entries, in master order;
//     ids that no longer exist in the master history are ignored.
// NOTE for future resume generation (F-phases that build application
// documents): it MUST use the profile's per-profile fields and the
// presentedHistory selection, NOT the whole person history. Attempts
// already pin the profile snapshot (body_json, which carries the
// selection) plus a full person snapshot, so a past attempt keeps
// resolving to what was presented at that moment; do not change
// attempt/snapshot logic to "fix" this — read the selection at
// generation time instead.

/**
 * R4: a profile's CV must be explicitly selected for THAT profile and
 * confirmed. A confirmed CV of the person that no profile selected does
 * not count, and the same confirmed CV may be reused across profiles.
 * @param {any} db
 * @param {string} personId
 * @param {string | undefined} cvImportId
 */
export function assertValidProfileCv(db, personId, cvImportId) {
  if (cvImportId === undefined || cvImportId === null || cvImportId === "") return;
  if (typeof cvImportId !== "string") throw new Error("cv_import_id must be a string");
  // Selection accepts a fully confirmed CV and a conflicted one: the
  // user must be able to select a conflicted CV in order to resolve
  // it. Validation (readiness, attempts) is stricter — see profileCv
  // and profileReadiness, which require a fully confirmed CV.
  const cv = getProfileCvImport(db, cvImportId);
  if (!cv) throw new Error("the profile CV must be a confirmed CV import");
  if (cv.person_id !== personId) throw new Error("the profile CV must belong to the same person");
}

/** The profile's selected CV, only when it is confirmed (R4). */
export function profileCv(db, profile) {
  const cvImportId = profile.body?.cv_import_id;
  if (!cvImportId) return null;
  const cv = getValidatedCvImport(db, cvImportId);
  if (!cv || cv.person_id !== profile.person_id) return null;
  return cv;
}

/** Validate a profile body: unknown keys are rejected, factRefs must be concept/scope pairs. */
function checkProfileStringArray(body, key) {
  if (body[key] === undefined) return;
  if (!Array.isArray(body[key])) throw new Error(`${key} must be an array`);
  for (const v of body[key]) {
    if (typeof v !== "string" || v.trim() === "") throw new Error(`each ${key} entry must be a non-empty string`);
  }
}

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
  // Per-profile fields (user-approved redesign 2026-10-28): same shapes
  // as the person fields they mirror, so a profile can present its own
  // roles, locations, skills, exclusions and salary without touching
  // the person's universal data.
  for (const key of ["desired_roles", "locations", "skills", "exclusions", "employment_ids", "education_ids"]) {
    checkProfileStringArray(body, key);
  }
  if (body.salary_expectations !== undefined) {
    const s = body.salary_expectations;
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("salary_expectations must be an object");
    for (const k of Object.keys(s)) {
      if (!["currency", "min", "max", "period"].includes(k)) throw new Error(`unknown salary_expectations field: ${k}`);
    }
    if (s.min !== undefined && typeof s.min !== "number") throw new Error("salary_expectations.min must be a number");
    if (s.max !== undefined && typeof s.max !== "number") throw new Error("salary_expectations.max must be a number");
    if (s.min !== undefined && s.max !== undefined && s.min > s.max) throw new Error("salary_expectations.min must not exceed max");
  }
  return { ...body };
}

/**
 * Which master-history entries a profile presents, given the person's
 * details and the profile body. Absent selection key -> all entries
 * (backward compatible); empty array -> none; otherwise exactly the
 * listed ids, in master order, with unknown ids ignored. This is the
 * presentation rule future resume generation must use; it changes
 * nothing stored.
 */
export function presentedHistory(personDetails, profileBody) {
  const select = (entries, key) => {
    const list = entries || [];
    const ids = profileBody?.[key];
    if (ids === undefined) return list;
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const wanted = new Set(ids);
    return list.filter((e) => wanted.has(e.id));
  };
  return {
    employment: select(personDetails?.employment, "employment_ids"),
    education: select(personDetails?.education, "education_ids"),
  };
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
  assertValidProfileCv(db, personId, valid.cv_import_id);
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
 * confirmed, a validated CV EXPLICITLY SELECTED FOR THIS PROFILE (R4:
 * another profile's CV does not count), every required policy
 * accepted, the apply-on-behalf consent recorded, and xAI VERIFIED
 * (R3: a configured key is not enough — pass { xaiVerified } from the
 * server, which knows whether the current key + model pair has a
 * successful verification record; the default, false, blocks rather
 * than assuming xAI). A deleted profile is never ready (R6). The
 * returned `missing` list is the explained block, never a silent pass.
 * @param {any} db
 * @param {string} profileId
 * @param {{xaiVerified?: boolean}} [opts]
 * @returns {{ready: boolean, missing: string[]}}
 */
export function profileReadiness(db, profileId, opts = {}) {
  const profile = getProfileFull(db, profileId);
  if (!profile) throw new Error("profile not found");
  // R6: a deleted profile can never be ready, whatever else holds.
  if (profile.deleted) return { ready: false, missing: ["profile_deleted"] };
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
  if (!profileCv(db, profile)) {
    // A precisely explained block: a selected CV with unresolved
    // conflicts is a different reason from having no validated CV at
    // all, and it is resolved by resolving the conflicts, not by
    // picking another CV. createAttempt calls this readiness check
    // before opening any transaction, so a blocked attempt creates
    // no snapshot and no attempt row.
    const assigned = profile.body.cv_import_id ? getCvImport(db, profile.body.cv_import_id) : null;
    missing.push(assigned?.status === "confirmed_with_conflicts" ? "cv_conflicts_unresolved" : "cv_validated");
  }
  if (!requiredPoliciesAccepted(db, profile.person_id)) missing.push("policy");
  if (!hasConsent(db, profile.person_id, "apply_on_behalf")) missing.push("consent");
  if (!opts.xaiVerified) missing.push("xai");
  return { ready: missing.length === 0, missing };
}

/**
 * Create a send attempt pinning the profile snapshot in force, a
 * snapshot of the whole person, AND the CV version chosen for this
 * profile (R4), in one transaction, and storing the resolved fact
 * content on the attempt. Later person, profile, fact or CV changes
 * never rewrite this stored content. R6: a deleted profile is
 * rejected here, before any snapshot or attempt row is created, so a
 * stale tab or a direct API call cannot create an attempt from it.
 * NOTE (redesign 2026-10-28): the person snapshot stays the WHOLE
 * person (master history); it is not filtered here. When a future
 * step generates application documents from an attempt, it must apply
 * presentedHistory(personSnapshotDetails, profileSnapshotBody) and the
 * profile's per-profile fields, so the attempt presents the profile's
 * selection rather than the whole history.
 * @param {any} db
 * @param {string} personId
 * @param {string} profileId
 * @param {string} offerId
 * @param {{xaiVerified?: boolean}} [opts]
 * @returns {string}
 */
export function createAttempt(db, personId, profileId, offerId, opts = {}) {
  const profile = getProfileFull(db, profileId);
  if (!profile) throw new Error("profile not found");
  if (profile.deleted) throw new Error("profile is deleted: a deleted profile cannot create a new attempt");
  const readiness = profileReadiness(db, profileId, opts);
  if (!readiness.ready) throw new Error(`profile is not ready: missing ${readiness.missing.join(", ")}`);
  db.exec("BEGIN IMMEDIATE");
  try {
    const snapshotId = pinSnapshot(db, profileId);
    const personSnapshotId = snapshotPerson(db, personId);
    const cv = profileCv(db, profile);
    const resolved = {};
    for (const ref of profile.body.factRefs ?? []) {
      const fact = getConfirmedFact(db, personId, ref.concept, ref.scope ?? "");
      if (fact) resolved[`${ref.concept}@${ref.scope ?? ""}`] = fact.value;
    }
    const id = randomUUID();
    db.prepare(
      "INSERT INTO attempts (id, person_id, profile_id, profile_snapshot_id, person_snapshot_id, cv_import_id, cv_snapshot_json, offer_id, status, evidence_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?)",
    ).run(id, personId, profileId, snapshotId, personSnapshotId, cv ? cv.id : null,
      JSON.stringify(cv ? { id: cv.id, filename: cv.filename, format: cv.format, extracted_text: cv.extracted_text, status: cv.status, confirmed_at: cv.confirmed_at, proposals: cv.proposals } : {}),
      offerId, JSON.stringify({ snapshotVersion: profile.version, resolvedFacts: resolved, cvImportId: cv ? cv.id : null }));
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
  try {
    attempt.cvSnapshot = row.cv_snapshot_json ? JSON.parse(row.cv_snapshot_json) : null;
  } catch {
    attempt.cvSnapshot = null;
  }
  return attempt;
}
