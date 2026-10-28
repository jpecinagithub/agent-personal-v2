// T-V2-016 / T-V2-017: Profiles. At most 10 active (non-archived)
// profiles per person; creating an 11th is rejected. Profiles share one
// declared-facts repository: the profile body holds fact REFERENCES
// ({concept, scope} pairs), never copies of fact values, so a profile
// never stores duplicated facts. Sending pins the snapshot in force at
// that moment; later profile changes never alter a past attempt's
// resolved content, which is stored on the attempt itself.
import { randomUUID } from "node:crypto";
import { getConfirmedFact } from "./facts.mjs";

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

export function countActiveProfiles(db, personId) {
  return db.prepare("SELECT COUNT(*) AS n FROM profiles WHERE person_id = ? AND archived = 0").get(personId).n;
}

export function createProfileFull(db, personId, name, body = {}) {
  if (typeof name !== "string" || name.trim() === "") throw new Error("profile name is required");
  if (!db.prepare("SELECT id FROM persons WHERE id = ?").get(personId)) throw new Error("person not found");
  if (countActiveProfiles(db, personId) >= MAX_PROFILES) {
    throw new Error(`profile limit reached: at most ${MAX_PROFILES} active profiles per person`);
  }
  const valid = validateProfileBody(body);
  const id = randomUUID();
  db.prepare("INSERT INTO profiles (id, person_id, name, focus, template, body_json) VALUES (?, ?, ?, ?, ?, ?)").run(
    id, personId, name.trim(), valid.focus ?? "", valid.template ?? "", JSON.stringify(valid),
  );
  return id;
}

export function listProfiles(db, personId) {
  return db.prepare("SELECT * FROM profiles WHERE person_id = ? ORDER BY created_at ASC").all(personId).map((r) => ({
    ...r, body: JSON.parse(r.body_json), archived: r.archived === 1,
  }));
}

export function getProfileFull(db, profileId) {
  const row = db.prepare("SELECT * FROM profiles WHERE id = ?").get(profileId);
  if (!row) return null;
  return { ...row, body: JSON.parse(row.body_json), archived: row.archived === 1 };
}

export function archiveProfile(db, profileId) {
  const r = db.prepare("UPDATE profiles SET archived = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND archived = 0").run(profileId);
  if (r.changes === 0) throw new Error("profile not found or already archived");
}

export function unarchiveProfile(db, profileId) {
  const profile = getProfileFull(db, profileId);
  if (!profile) throw new Error("profile not found");
  if (countActiveProfiles(db, profile.person_id) >= MAX_PROFILES) {
    throw new Error(`profile limit reached: at most ${MAX_PROFILES} active profiles per person`);
  }
  db.prepare("UPDATE profiles SET archived = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(profileId);
}

export function deleteProfile(db, profileId) {
  const profile = getProfileFull(db, profileId);
  if (!profile) throw new Error("profile not found");
  if (!profile.archived) throw new Error("only an archived profile can be deleted");
  const used = db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE profile_snapshot_id IN (SELECT id FROM profile_snapshots WHERE profile_id = ?)").get(profileId).n;
  if (used > 0) throw new Error("profile cannot be deleted: past attempts reference its snapshots");
  db.prepare("DELETE FROM profile_snapshots WHERE profile_id = ?").run(profileId);
  db.prepare("DELETE FROM profile_drafts WHERE profile_id = ?").run(profileId);
  db.prepare("DELETE FROM profiles WHERE id = ?").run(profileId);
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
 * Readiness: a profile is ready when it has a name and a focus and
 * every referenced fact resolves to a confirmed declared fact. The
 * returned `missing` list is the explained block, never a silent pass.
 */
export function profileReadiness(db, profileId) {
  const profile = getProfileFull(db, profileId);
  if (!profile) throw new Error("profile not found");
  const missing = [];
  if (!profile.name.trim()) missing.push("name");
  if (!profile.body.focus || !String(profile.body.focus).trim()) missing.push("focus");
  for (const ref of profile.body.factRefs ?? []) {
    if (!getConfirmedFact(db, profile.person_id, ref.concept, ref.scope ?? "")) {
      missing.push(`fact ${ref.concept}${ref.scope ? ` (${ref.scope})` : ""}`);
    }
  }
  return { ready: missing.length === 0, missing };
}

/**
 * Create a send attempt pinning the snapshot in force and storing the
 * resolved fact content on the attempt. Later profile or fact changes
 * never rewrite this stored content: past attempts keep what was sent.
 * The attempt requires a ready profile (see profileReadiness).
 */
export function createAttempt(db, personId, profileId, offerId) {
  const readiness = profileReadiness(db, profileId);
  if (!readiness.ready) throw new Error(`profile is not ready: missing ${readiness.missing.join(", ")}`);
  const profile = getProfileFull(db, profileId);
  const snapshotId = pinSnapshot(db, profileId);
  const resolved = {};
  for (const ref of profile.body.factRefs ?? []) {
    const fact = getConfirmedFact(db, personId, ref.concept, ref.scope ?? "");
    if (fact) resolved[`${ref.concept}@${ref.scope ?? ""}`] = fact.value;
  }
  const id = randomUUID();
  db.prepare(
    "INSERT INTO attempts (id, person_id, profile_id, profile_snapshot_id, offer_id, status, evidence_json) VALUES (?, ?, ?, ?, ?, 'prepared', ?)",
  ).run(id, personId, profileId, snapshotId, offerId, JSON.stringify({ snapshotVersion: profile.version, resolvedFacts: resolved }));
  return id;
}

export function getAttempt(db, attemptId) {
  const row = db.prepare("SELECT * FROM attempts WHERE id = ?").get(attemptId);
  if (!row) return null;
  return { ...row, evidence: JSON.parse(row.evidence_json) };
}
