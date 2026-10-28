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
  if (typeof details.email === "string" && details.email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email)) {
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
      if (a.valid_until !== undefined && a.valid_until !== null && !DATE_RE.test(a.valid_until)) {
        throw new Error("authorisation valid_until must be YYYY or YYYY-MM");
      }
      if (a.sponsorship_required !== undefined && typeof a.sponsorship_required !== "boolean") {
        throw new Error("authorisation sponsorship_required must be a boolean");
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

/**
 * Merge a partial patch into stored person details — this is the R2
 * (G2 re-review) fix for the old replace-the-whole-object behaviour.
 * Rules, all of which exist so that saving can never silently delete
 * data the caller did not represent:
 * - A top-level field absent from the patch is PRESERVED, not cleared.
 *   A field present in the patch replaces the stored value (including
 *   an empty array, which explicitly clears a list).
 * - Employment/education entries match by STABLE ID, never by position:
 *   an entry with a known id merges field-by-field (present fields
 *   overwrite, absent fields are preserved); an entry with a new id is
 *   added; an entry with deleted: true is removed. Entries absent from
 *   the patch array are PRESERVED — omission is never a deletion.
 * - The merged result is fully validated (required identity/contact,
 *   date precision YYYY or YYYY-MM, stable ids), so a patch cannot
 *   produce an invalid person either.
 * @param {Record<string, any>} existing stored details
 * @param {Record<string, any>} patch partial update
 * @returns {Record<string, any>} merged, validated details
 */
/**
 * Merge one entry array by stable identity, never by position and
 * never by blind replacement. A null field value inside an entry is
 * an EXPLICIT CLEAR of that nested property (the key is removed);
 * an absent field is preserved. New entries strip null-valued keys.
 * @param {any[]} current stored entries
 * @param {any[]} patch entries
 * @param {string} section field name, for error messages
 * @param {(entry: any) => string | null} keyOf how to identify an entry
 * @param {boolean} idRequired whether an entry without an id is an error
 * @returns {any[]}
 */
function mergeEntryArray(current, patch, section, keyOf, idRequired) {
  const byKey = new Map();
  const order = [];
  for (const e of current) {
    let k = keyOf(e);
    if (k === null) continue;
    // Never silently drop a stored entry: if two current entries share
    // a natural key (e.g. two authorisations for one country), the
    // duplicate keeps a unique internal key and survives untouched.
    if (byKey.has(k)) k = `${k}#dup${order.length}`;
    byKey.set(k, e);
    order.push(k);
  }
  const mentioned = [];
  for (const entry of patch) {
    if (!entry || typeof entry !== "object") throw new Error(`each ${section} entry must be an object`);
    let key = keyOf(entry);
    if (key === null) {
      if (idRequired) throw new Error(`each ${section} entry needs an id`);
      // Legacy entry without an id: it is a new entry, and it gains
      // one now so later saves can address it by id.
      key = randomUUID();
      entry.id = key;
    }
    if (entry.deleted === true) {
      byKey.delete(key);
      const at = order.indexOf(key);
      if (at >= 0) order.splice(at, 1);
      continue;
    }
    mentioned.push(key);
    if (byKey.has(key)) {
      const kept = byKey.get(key);
      for (const [k, v] of Object.entries(entry)) {
        if (k === "deleted" || k === "id") continue;
        if (v === null) delete kept[k];
        else kept[k] = v;
      }
      // Note: authorisations no longer use this generic merge (see
      // mergeAuthorisations below); employment/education entries
      // always carry ids, so no id assignment happens here.
    } else {
      const fresh = {};
      for (const [k, v] of Object.entries(entry)) {
        if (k !== "deleted" && v !== null) fresh[k] = v;
      }
      byKey.set(key, fresh);
      order.push(key);
    }
  }
  // Order: when the patch names every surviving entry (the UI sending
  // its full list), the patch order wins, so an explicit reorder takes
  // effect. When it names only a subset (a partial patch), the original
  // relative order is kept and new entries append — a partial edit
  // must never silently reorder history. Either way the id travels
  // with the entry: reordering never renames anything.
  const coversAll = order.every((id) => mentioned.includes(id));
  return (coversAll ? mentioned : order).map((id) => byKey.get(id));
}

function normIdentityValue(v) {
  if (v === undefined || v === null || v === "") return undefined;
  return v;
}

// Full field identity for authorisations (G2 re-review 3): the
// canonical fields must ALL match — country, status, validity and
// sponsorship — and any extra stored field must also match. Country
// alone is NEVER enough: two entries for one country with different
// status, validity or sponsorship are different authorisations.
// Empty values normalise to absent, and an absent sponsorship flag
// reads as false (the form's checkbox semantics: unchecked is false).
function authIdentityMatches(stored, incoming) {
  const keys = new Set([...Object.keys(stored), ...Object.keys(incoming)]);
  for (const k of keys) {
    if (k === "id" || k === "deleted") continue;
    let a = normIdentityValue(stored[k]);
    let b = normIdentityValue(incoming[k]);
    if (k === "sponsorship_required") { a = a ?? false; b = b ?? false; }
    if (a !== b) return false;
  }
  return true;
}

// Authorisations merge (G2 re-review 3). Entries with an id match by
// id. Entries WITHOUT an id match a stored id-less entry ONLY on
// full field identity (see authIdentityMatches): the stored entry is
// then adopted and persists a stable id, so later saves address it
// by id. An id-less entry with no full-identity match is a NEW entry
// (never a country-only merge). An id-less deletion marker removes
// only the fully matching stored entry. Stored entries are never
// silently dropped: unmentioned entries survive in original order,
// and when the patch names every surviving entry, patch order wins
// (so an explicit reorder takes effect), exactly as the generic
// merge does for employment/education.
function mergeAuthorisations(current, patch) {
  const byId = new Map();
  const idLess = [];
  const order = [];
  for (const e of current) {
    if (!e || typeof e !== "object") throw new Error("each authorisations entry must be an object");
    if (isNonEmptyString(e.id)) {
      if (!byId.has(e.id)) { byId.set(e.id, e); order.push({ kind: "id", key: e.id }); }
      else order.push({ kind: "entry", entry: e });
    } else {
      idLess.push(e);
      order.push({ kind: "legacy", entry: e });
    }
  }
  const mentioned = [];
  const mentionedKeys = new Set();
  const noteMentioned = (key) => { if (!mentionedKeys.has(key)) { mentionedKeys.add(key); mentioned.push({ kind: "id", key }); } };
  const applyFields = (kept, entry) => {
    for (const [k, v] of Object.entries(entry)) {
      if (k === "deleted" || k === "id") continue;
      if (v === null) delete kept[k]; else kept[k] = v;
    }
  };
  const freshEntry = (entry, id) => {
    const fresh = { id };
    for (const [k, v] of Object.entries(entry)) if (k !== "deleted" && v !== null) fresh[k] = v;
    return fresh;
  };
  for (const entry of patch) {
    if (!entry || typeof entry !== "object") throw new Error("each authorisations entry must be an object");
    const id = isNonEmptyString(entry.id) ? entry.id : null;
    if (entry.deleted === true) {
      if (id) {
        byId.delete(id);
        const at = order.findIndex((s) => s.kind === "id" && s.key === id);
        if (at >= 0) order.splice(at, 1);
      } else {
        const at = idLess.findIndex((s) => authIdentityMatches(s, entry));
        if (at >= 0) {
          const victim = idLess.splice(at, 1)[0];
          const oi = order.findIndex((s) => s.kind === "legacy" && s.entry === victim);
          if (oi >= 0) order.splice(oi, 1);
        }
      }
      continue;
    }
    if (id) {
      if (byId.has(id)) {
        applyFields(byId.get(id), entry);
      } else {
        const fresh = freshEntry(entry, id);
        byId.set(id, fresh);
        order.push({ kind: "id", key: id });
      }
      noteMentioned(id);
      continue;
    }
    const at = idLess.findIndex((s) => authIdentityMatches(s, entry));
    if (at >= 0) {
      const adopted = idLess.splice(at, 1)[0];
      adopted.id = randomUUID();
      applyFields(adopted, entry);
      byId.set(adopted.id, adopted);
      const oi = order.findIndex((s) => s.kind === "legacy" && s.entry === adopted);
      if (oi >= 0) order[oi] = { kind: "id", key: adopted.id };
      noteMentioned(adopted.id);
    } else {
      const fresh = freshEntry(entry, randomUUID());
      byId.set(fresh.id, fresh);
      order.push({ kind: "id", key: fresh.id });
      noteMentioned(fresh.id);
    }
  }
  const coversAll = order.every((s) => (s.kind === "id" ? mentionedKeys.has(s.key) : false));
  const finalOrder = coversAll ? mentioned : order;
  const out = [];
  for (const s of finalOrder) {
    if (s.kind === "id") { const e = byId.get(s.key); if (e) out.push(e); }
    else out.push(s.entry);
  }
  return out;
}

export function mergePersonDetails(existing, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("person patch must be an object");
  }
  for (const key of Object.keys(patch)) {
    if (!ALLOWED_KEYS.has(key)) throw new Error(`unknown person field: ${key}`);
  }
  const merged = JSON.parse(JSON.stringify(existing ?? {}));
  for (const [key, value] of Object.entries(patch)) {
    if (key === "employment" || key === "education") {
      if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
      merged[key] = mergeEntryArray(
        Array.isArray(merged[key]) ? merged[key] : [], value, key,
        (e) => (isNonEmptyString(e?.id) ? e.id : null), true,
      );
      continue;
    }
    if (key === "authorisations") {
      if (!Array.isArray(value)) throw new Error("authorisations must be an array");
      merged[key] = mergeAuthorisations(
        Array.isArray(merged[key]) ? merged[key] : [], value,
      );
      continue;
    }
    // Explicit deletion vs absence, at top level too: a null value
    // clears the field; an absent key preserves it. (Employment,
    // education and authorisations are handled above; every other
    // field, including an empty array, replaces when present.)
    if (value === null) delete merged[key];
    else merged[key] = value;
  }
  return validatePersonDetails(merged);
}

export function updatePersonDetails(db, personId, details) {
  const existing = getPerson(db, personId);
  if (!existing) throw new Error("person not found");
  const valid = mergePersonDetails(existing.details ?? {}, details);
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
