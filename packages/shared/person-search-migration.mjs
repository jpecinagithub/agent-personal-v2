// User-approved split 2026-10-29: search-preference fields moved from
// the person record to profiles. Legacy person rows (created before
// the split, e.g. by the old UI defaults section or by the user's
// local update-person-fields.mjs helper, which is now OBSOLETE — it
// sets search fields on the person, which the person API now rejects)
// may still carry desired_roles, locations, skills, exclusions or
// salary_expectations. This migration moves each such field into the
// person's FIRST non-deleted profile (oldest by creation) ONLY where
// that profile's corresponding field is empty/absent — a profile's own
// values are never overwritten — then deletes the fields from the
// person. If the person has no non-deleted profile, one is created
// for them, named from their first desired role when present, else
// "Perfil principal", holding the moved fields.
//
// Idempotent by construction: after a run, no person carries legacy
// fields, so a second run moves nothing (and creates no profile).
// Runs on every openDatabase (see packages/shared/db.mjs) so an
// existing local database is migrated on first start after upgrade.
// It writes profile bodies directly, without snapshots: this is a
// data migration, not a user edit, and snapshotting it would pollute
// the attempt history with a move the user did not make. All moves
// for all persons happen in ONE transaction: a failure rolls
// everything back instead of half-moving one person.
// A field counts as "empty" on the profile side when it is absent, an
// empty array, or (for salary) an object with no keys; a "present"
// person value that is itself empty is simply deleted, not moved.
import { randomUUID } from "node:crypto";

export const LEGACY_PERSON_SEARCH_FIELDS = [
  "desired_roles", "locations", "skills", "exclusions", "salary_expectations",
];

const ARRAY_FIELDS = new Set(["desired_roles", "locations", "skills", "exclusions"]);

function isEmptyValue(key, value) {
  if (value === undefined || value === null) return true;
  if (ARRAY_FIELDS.has(key)) return !Array.isArray(value) || value.length === 0;
  if (key === "salary_expectations") return typeof value !== "object" || Object.keys(value).length === 0;
  return false;
}

function profileNameFor(details) {
  const roles = details.desired_roles;
  if (Array.isArray(roles) && roles.length > 0 && typeof roles[0] === "string" && roles[0].trim() !== "") {
    return roles[0].trim();
  }
  return "Perfil principal";
}

/** @param {any} db */
export function migrateLegacyPersonSearchFields(db) {
  const persons = db.prepare("SELECT * FROM persons ORDER BY created_at ASC, rowid ASC").all();
  if (persons.length === 0) return { personsMoved: 0, profilesCreated: 0 };
  let personsMoved = 0;
  let profilesCreated = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const person of persons) {
      let details;
      try {
        details = JSON.parse(person.details_json ?? "{}");
      } catch {
        continue;
      }
      const legacy = LEGACY_PERSON_SEARCH_FIELDS.filter((k) => details[k] !== undefined);
      if (legacy.length === 0) continue;
      const profiles = db.prepare(
        "SELECT * FROM profiles WHERE person_id = ? AND deleted = 0 ORDER BY created_at ASC, rowid ASC",
      ).all(person.id);
      let target = profiles[0] ?? null;
      let body = {};
      if (target) {
        body = JSON.parse(target.body_json ?? "{}");
      } else {
        target = null;
      }
      const moved = {};
      for (const key of legacy) {
        if (!isEmptyValue(key, details[key]) && isEmptyValue(key, body[key])) {
          moved[key] = details[key];
        }
      }
      if (target) {
        if (Object.keys(moved).length > 0) {
          const next = { ...body, ...moved };
          db.prepare("UPDATE profiles SET body_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
            JSON.stringify(next), target.id,
          );
        }
      } else if (Object.keys(moved).length > 0) {
        const id = randomUUID();
        db.prepare("INSERT INTO profiles (id, person_id, name, template, body_json) VALUES (?, ?, ?, '', ?)").run(
          id, person.id, profileNameFor(details), JSON.stringify(moved),
        );
        profilesCreated += 1;
      }
      // Delete ALL legacy keys from the person, moved or not: an
      // empty legacy value has nothing to move, and a value the
      // profile already owned stays owned by the profile alone.
      for (const key of legacy) delete details[key];
      db.prepare("UPDATE persons SET details_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
        JSON.stringify(details), person.id,
      );
      personsMoved += 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Already rolled back; keep the original error.
    }
    throw err;
  }
  return { personsMoved, profilesCreated };
}
