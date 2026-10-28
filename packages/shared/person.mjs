// Pliego T-V2-015 (identity/contacts), T-V2-017 (employment/education
// CRUD) and T-V2-018 (language/skill/authorisation editors): Person
// entity. All personal data in this project is
// declared by the user through the UI; nothing here invents, infers or
// preloads a real person's facts. Test data in the suite is synthetic
// ("Test Person"). Unknown fields are rejected, never silently stored.
import { randomUUID } from "node:crypto";

const ALLOWED_KEYS = new Set([
  "full_name", "display_name", "email", "phone", "languages",
  "authorisations", "availability", "exclusions", "desired_roles",
  "locations", "salary_expectations", "employment", "education",
  "links", "skills",
]);

const DATE_RE = /^\d{4}(-\d{2})?$/;

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function checkStringArray(value, field) {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
}

/**
 * Validate a person details object. Throws on any unknown field, on
 * missing required fields, or on malformed nested entries. Returns the
 * details unchanged (a copy) when valid.
 * @param {Record<string, any>} details
 * @returns {Record<string, any>}
 */
export function validatePersonDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    throw new Error("person details must be an object");
  }
  for (const key of Object.keys(details)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`unknown person field: ${key}`);
  }
  if (!isNonEmptyString(details.full_name)) throw new Error("full_name is required");
  if (!isNonEmptyString(details.email) && !isNonEmptyString(details.phone)) {
    throw new Error("at least one contact method (email or phone) is required");
  }
  if (details.email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) {
    throw new Error("email is not a valid address");
  }
  if (details.languages !== undefined) {
    if (!Array.isArray(details.languages)) throw new Error("languages must be an array");
    for (const l of details.languages) {
      if (!l || !isNonEmptyString(l.language) || !isNonEmptyString(l.level)) {
        throw new Error("each language needs a language and a level");
      }
    }
  }
  if (details.authorisations !== undefined) {
    if (!Array.isArray(details.authorisations)) throw new Error("authorisations must be an array");
    for (const a of details.authorisations) {
      if (!a || !isNonEmptyString(a.country) || !isNonEmptyString(a.status)) {
        throw new Error("each authorisation needs a country and a status");
      }
    }
  }
  if (details.exclusions !== undefined) checkStringArray(details.exclusions, "exclusions");
  if (details.desired_roles !== undefined) checkStringArray(details.desired_roles, "desired_roles");
  if (details.locations !== undefined) checkStringArray(details.locations, "locations");
  if (details.skills !== undefined) checkStringArray(details.skills, "skills");
  if (details.links !== undefined) checkStringArray(details.links, "links");
  if (details.salary_expectations !== undefined) {
    const s = details.salary_expectations;
    if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("salary_expectations must be an object");
    for (const k of Object.keys(s)) {
      if (!["currency", "min", "max", "period"].includes(k)) throw new Error(`unknown salary_expectations field: ${k}`);
    }
    if (s.min !== undefined && typeof s.min !== "number") throw new Error("salary_expectations.min must be a number");
    if (s.max !== undefined && typeof s.max !== "number") throw new Error("salary_expectations.max must be a number");
    if (s.min !== undefined && s.max !== undefined && s.min > s.max) throw new Error("salary_expectations.min must not exceed max");
  }
  for (const section of ["employment", "education"]) {
    if (details[section] === undefined) continue;
    if (!Array.isArray(details[section])) throw new Error(`${section} must be an array`);
    for (const e of details[section]) {
      if (!e || !isNonEmptyString(e.id)) throw new Error(`each ${section} entry needs an id`);
      if (!isNonEmptyString(e.title) && !isNonEmptyString(e.institution) && !isNonEmptyString(e.employer)) {
        throw new Error(`each ${section} entry needs a title, employer or institution`);
      }
      if (e.start !== undefined && !DATE_RE.test(e.start)) throw new Error(`${section} start must be YYYY or YYYY-MM`);
      if (e.end !== undefined && e.end !== null && !DATE_RE.test(e.end)) throw new Error(`${section} end must be YYYY or YYYY-MM`);
    }
  }
  return { ...details };
}

export function createPersonFull(db, details) {
  const valid = validatePersonDetails(details);
  const id = randomUUID();
  const displayName = valid.display_name ?? valid.full_name;
  db.prepare("INSERT INTO persons (id, display_name, contact_json, details_json) VALUES (?, ?, ?, ?)").run(
    id, displayName,
    JSON.stringify({ email: valid.email ?? null, phone: valid.phone ?? null }),
    JSON.stringify(valid),
  );
  return id;
}

export function updatePersonDetails(db, personId, details) {
  const valid = validatePersonDetails(details);
  const r = db.prepare("UPDATE persons SET display_name = ?, contact_json = ?, details_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
    valid.display_name ?? valid.full_name,
    JSON.stringify({ email: valid.email ?? null, phone: valid.phone ?? null }),
    JSON.stringify(valid), personId,
  );
  if (r.changes === 0) throw new Error("person not found");
}

export function getPerson(db, personId) {
  const row = db.prepare("SELECT * FROM persons WHERE id = ?").get(personId);
  if (!row) return null;
  return { ...row, contact: JSON.parse(row.contact_json), details: JSON.parse(row.details_json) };
}

export function listPersons(db) {
  return db.prepare("SELECT * FROM persons ORDER BY created_at ASC").all().map((row) => ({
    ...row, contact: JSON.parse(row.contact_json), details: JSON.parse(row.details_json),
  }));
}
