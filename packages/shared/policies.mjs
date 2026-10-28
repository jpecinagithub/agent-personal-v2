// Pliego T-V2-022 + RF-V2-020: policies, consents and settings.
// Policies are seeded by migration 003. A policy acceptance is recorded
// as a consent row for that policy key. Separately, "apply_on_behalf" is
// the user's consent for the agent to present applications on their
// behalf. Readiness (see profiles.mjs) requires: every required policy
// accepted AND the apply_on_behalf consent recorded AND a validated CV
// AND xAI available. Automatic mode is OFF initially (RF-V2-008) and
// can only be enabled when at least one profile is ready and the
// auto_apply policy has been accepted; it can always be disabled
// immediately.
import { randomUUID } from "node:crypto";

/**
 * @param {any} db
 * @returns {any[]}
 */
export function listPolicies(db) {
  return db.prepare("SELECT * FROM policies ORDER BY key ASC").all();
}

/**
 * @param {any} db
 * @param {string} personId
 * @returns {any[]}
 */
export function listConsents(db, personId) {
  return db.prepare("SELECT * FROM consents WHERE person_id = ? ORDER BY consent_key ASC").all(personId);
}

/**
 * @param {any} db
 * @param {string} personId
 * @param {string} consentKey
 * @returns {boolean}
 */
export function hasConsent(db, personId, consentKey) {
  return db.prepare("SELECT COUNT(*) AS n FROM consents WHERE person_id = ? AND consent_key = ? AND accepted = 1").get(personId, consentKey).n > 0;
}

/**
 * Record a consent. Idempotent: recording the same consent twice keeps
 * a single row.
 * @param {any} db
 * @param {string} personId
 * @param {string} consentKey
 * @returns {string}
 */
export function giveConsent(db, personId, consentKey) {
  if (!db.prepare("SELECT id FROM persons WHERE id = ?").get(personId)) throw new Error("person not found");
  if (typeof consentKey !== "string" || !consentKey.trim()) throw new Error("consent key is required");
  const existing = db.prepare("SELECT id FROM consents WHERE person_id = ? AND consent_key = ?").get(personId, consentKey);
  if (existing) {
    db.prepare("UPDATE consents SET accepted = 1, accepted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(existing.id);
    return existing.id;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO consents (id, person_id, consent_key, accepted) VALUES (?, ?, ?, 1)").run(id, personId, consentKey);
  return id;
}

/**
 * Accept a policy: the policy must exist; acceptance is the consent row
 * for that policy key.
 * @param {any} db
 * @param {string} personId
 * @param {string} policyKey
 * @returns {string}
 */
export function acceptPolicy(db, personId, policyKey) {
  if (!db.prepare("SELECT key FROM policies WHERE key = ?").get(policyKey)) throw new Error(`unknown policy: ${policyKey}`);
  return giveConsent(db, personId, policyKey);
}

/**
 * @param {any} db
 * @param {string} personId
 * @returns {boolean}
 */
export function requiredPoliciesAccepted(db, personId) {
  const required = db.prepare("SELECT key FROM policies WHERE required = 1").all();
  return required.every((/** @type {any} */ p) => hasConsent(db, personId, p.key));
}

/**
 * @param {any} db
 * @param {string} key
 * @returns {any}
 */
export function getSetting(db, key) {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key);
  return row ? JSON.parse(row.value_json) : null;
}

/**
 * @param {any} db
 * @param {string} key
 * @param {any} value
 */
export function setSetting(db, key, value) {
  db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(key, JSON.stringify(value));
}
