// Pliego T-V2-019: Declared facts (concept dictionary + scoped editors).
// A fact carries concept, scope, value,
// provenance and a confirmation state. Narrative text — including any LLM
// output — is NEVER stored as a personal fact: declareFact rejects
// provenance that names an LLM, a narrative or an inference. Only a
// confirmed fact may be used to answer a screening question (see
// resolve.mjs); pending facts are listed but never resolve.
import { randomUUID } from "node:crypto";

// Provenance values that are allowed to create facts. Anything that
// smells like model output is rejected here, not downstream.
const ALLOWED_PROVENANCE = new Set(["user", "cv-import", "portal-form", "manual", "document"]);
const REJECTED_PROVENANCE = /(llm|narrative|infer|model|generated)/i;

/**
 * @param {any} db
 * @param {{personId: string, concept: string, scope?: string, value: unknown, provenance: string, confirmationState?: string}} fact
 * @returns {string} fact id
 */
export function declareFact(db, { personId, concept, scope = "", value, provenance, confirmationState = "confirmed" }) {
  if (typeof concept !== "string" || concept.trim() === "") throw new Error("concept is required");
  if (value === undefined) throw new Error("value is required");
  if (typeof provenance !== "string" || !ALLOWED_PROVENANCE.has(provenance) || REJECTED_PROVENANCE.test(provenance)) {
    throw new Error(`provenance "${provenance}" cannot create a personal fact: narrative and LLM output are never facts`);
  }
  if (!["pending", "confirmed", "disputed"].includes(confirmationState)) {
    throw new Error(`unknown confirmation state: ${confirmationState}`);
  }
  const id = randomUUID();
  db.prepare(
    "INSERT INTO declared_facts (id, person_id, concept, scope, value_json, provenance, confirmation_state) VALUES (?, ?, ?, ?, ?, ?, ?) " +
    "ON CONFLICT(person_id, concept, scope) DO UPDATE SET value_json = excluded.value_json, provenance = excluded.provenance, confirmation_state = excluded.confirmation_state",
  ).run(id, personId, concept.trim(), scope, JSON.stringify(value), provenance, confirmationState);
  const row = db.prepare("SELECT id FROM declared_facts WHERE person_id = ? AND concept = ? AND scope = ?").get(personId, concept.trim(), scope);
  return row.id;
}

export function listFacts(db, personId) {
  return db.prepare("SELECT * FROM declared_facts WHERE person_id = ? ORDER BY concept ASC, scope ASC").all(personId).map((r) => ({
    ...r, value: JSON.parse(r.value_json),
  }));
}

/**
 * Delete one declared fact by id (G2 regression, 2026-10-28: the
 * domain UI lets the user delete a reusable declaration). Throws when
 * the id does not exist, so a UI delete can never silently no-op.
 * @param {any} db
 * @param {string} factId
 */
export function deleteFact(db, factId) {
  const r = db.prepare("DELETE FROM declared_facts WHERE id = ?").run(factId);
  if (r.changes === 0) throw new Error("fact not found");
}

export function getConfirmedFact(db, personId, concept, scope = "") {
  const row = db.prepare("SELECT * FROM declared_facts WHERE person_id = ? AND concept = ? AND scope = ? AND confirmation_state = 'confirmed'").get(personId, concept, scope);
  return row ? { ...row, value: JSON.parse(row.value_json) } : null;
}

export function factsForConcept(db, personId, concept) {
  return db.prepare("SELECT * FROM declared_facts WHERE person_id = ? AND concept = ? AND confirmation_state = 'confirmed' ORDER BY scope ASC").all(personId, concept).map((r) => ({
    ...r, value: JSON.parse(r.value_json),
  }));
}
