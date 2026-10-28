// G2 re-review 4 (2026-10-28): legacy authorisations with EXTRA fields
// must have persisted ids BEFORE they are presented for editing, so
// edit/delete resolve by id and never by deducing identity from
// mutable values. The user's fixture (accepted by the API, no id):
// ES / authorised / valid_until 2030-12 / sponsorship_required false
// plus valid_from 2025-01 and source_note "Synthetic user declaration".
// Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull, updatePersonDetails, getPerson } from "../packages/shared/person.mjs";

const EXTRA = {
  country: "ES",
  status: "authorised",
  valid_until: "2030-12",
  sponsorship_required: false,
  valid_from: "2025-01",
  source_note: "Synthetic user declaration",
};

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-rereview4-"));
  return openDatabase(path.join(dir, "agentv2.db"));
}

test("legacy authorisation with extra fields gains a persisted stable id on read, all fields intact", () => {
  const db = tmpDb();
  // Insert a genuinely legacy row, bypassing createPersonFull, as it
  // would exist from before ids: no id anywhere in the stored entry.
  const personId = "legacy-person-1";
  db.prepare("INSERT INTO persons (id, display_name, contact_json, details_json) VALUES (?, ?, ?, ?)").run(
    personId, "Synthetic Original",
    JSON.stringify({ email: "original@example.test", phone: null }),
    JSON.stringify({ full_name: "Synthetic Original", email: "original@example.test", authorisations: [{ ...EXTRA }] }),
  );
  const first = getPerson(db, personId).details.authorisations;
  assert.equal(first.length, 1);
  assert.ok(first[0].id, "the legacy entry gains an id on load");
  assert.equal(first[0].valid_from, "2025-01", "extra field preserved");
  assert.equal(first[0].source_note, "Synthetic user declaration", "extra field preserved");
  assert.equal(first[0].valid_until, "2030-12");
  // A second read returns the SAME id: the assignment was persisted,
  // not re-randomised on every read.
  const second = getPerson(db, personId).details.authorisations;
  assert.equal(second[0].id, first[0].id, "the id is stable across reads");
  const rawRow = /** @type {{ details_json: string }} */ (db.prepare("SELECT details_json FROM persons WHERE id = ?").get(personId));
  const raw = JSON.parse(rawRow.details_json);
  assert.equal(raw.authorisations[0].id, first[0].id, "the id is persisted in storage, not just in the response");
});

test("repeated saves by id preserve extra fields the screen never sends", () => {
  const db = tmpDb();
  const personId = createPersonFull(db, { full_name: "Synthetic Original", email: "original@example.test", authorisations: [{ ...EXTRA }] });
  const id = getPerson(db, personId).details.authorisations[0].id;
  assert.ok(id);
  // The screen rebuilds only country/status/validity/sponsorship.
  for (let round = 0; round < 3; round++) {
    updatePersonDetails(db, personId, { authorisations: [{ id, country: "ES", status: "authorised", valid_until: "2030-12", sponsorship_required: false }] });
  }
  const auths = getPerson(db, personId).details.authorisations;
  assert.equal(auths.length, 1, "no duplication across repeated saves");
  assert.equal(auths[0].id, id, "same entry");
  assert.equal(auths[0].valid_from, "2025-01", "extra field survives saves that never send it");
  assert.equal(auths[0].source_note, "Synthetic user declaration", "extra field survives saves that never send it");
});

test("editing a legacy authorisation with extra fields on first interaction updates it in place", () => {
  const db = tmpDb();
  const personId = createPersonFull(db, { full_name: "Synthetic Original", email: "original@example.test", authorisations: [{ ...EXTRA }] });
  const id = getPerson(db, personId).details.authorisations[0].id;
  updatePersonDetails(db, personId, { authorisations: [{ id, country: "ES", status: "authorised", valid_until: "2031-06", sponsorship_required: false }] });
  const auths = getPerson(db, personId).details.authorisations;
  assert.equal(auths.length, 1, "edit in place, no second entry");
  assert.equal(auths[0].id, id, "same entry");
  assert.equal(auths[0].valid_until, "2031-06", "the edit applied");
  assert.equal(auths[0].valid_from, "2025-01", "unedited extra field preserved");
  assert.equal(auths[0].source_note, "Synthetic user declaration", "unedited extra field preserved");
});

test("deleting a legacy authorisation with extra fields by id removes exactly that entry", () => {
  const db = tmpDb();
  const personId = createPersonFull(db, {
    full_name: "Synthetic Original",
    email: "original@example.test",
    authorisations: [{ ...EXTRA }, { country: "FR", status: "authorised", valid_until: "2029-06", sponsorship_required: true }],
  });
  const legacyId = getPerson(db, personId).details.authorisations.find((a) => a.country === "ES").id;
  updatePersonDetails(db, personId, { authorisations: [{ id: legacyId, deleted: true }] });
  const auths = getPerson(db, personId).details.authorisations;
  assert.equal(auths.length, 1, "only the deleted entry goes");
  assert.equal(auths[0].country, "FR", "the other entry is untouched");
});

test("two distinct authorisations for the same country stay distinct and individually editable/deletable", () => {
  const db = tmpDb();
  const personId = createPersonFull(db, {
    full_name: "Synthetic Original",
    email: "original@example.test",
    authorisations: [
      { ...EXTRA },
      { country: "ES", status: "authorised", valid_until: "2028-03", sponsorship_required: true, source_note: "Second synthetic entry" },
    ],
  });
  const auths = getPerson(db, personId).details.authorisations;
  assert.equal(auths.length, 2);
  assert.notEqual(auths[0].id, auths[1].id, "distinct persisted ids");
  // Edit the first only.
  updatePersonDetails(db, personId, { authorisations: [{ id: auths[0].id, country: "ES", status: "authorised", valid_until: "2032-01", sponsorship_required: false }] });
  let after = getPerson(db, personId).details.authorisations;
  assert.equal(after.length, 2);
  assert.equal(after.find((a) => a.id === auths[0].id).valid_until, "2032-01");
  assert.equal(after.find((a) => a.id === auths[1].id).valid_until, "2028-03", "the other entry is untouched");
  // Delete the second only.
  updatePersonDetails(db, personId, { authorisations: [{ id: auths[1].id, deleted: true }] });
  after = getPerson(db, personId).details.authorisations;
  assert.equal(after.length, 1);
  assert.equal(after[0].id, auths[0].id, "the edited entry survives the other's deletion");
});

test("an id-less deletion marker with full identity including extras still removes exactly that entry", () => {
  const db = tmpDb();
  // Bypass creation normalisation to exercise the marker path itself.
  const personId = "legacy-person-2";
  db.prepare("INSERT INTO persons (id, display_name, contact_json, details_json) VALUES (?, ?, ?, ?)").run(
    personId, "Synthetic Original",
    JSON.stringify({ email: "original@example.test", phone: null }),
    JSON.stringify({ full_name: "Synthetic Original", email: "original@example.test", authorisations: [{ ...EXTRA }, { country: "FR", status: "authorised" }] }),
  );
  // Note: reading via getPerson would normalise ids; the marker path
  // is exercised through updatePersonDetails, whose getPerson call
  // normalises first — so the marker must match the normalised entry
  // on full identity, which it does: every field, extras included.
  updatePersonDetails(db, personId, { authorisations: [{ deleted: true, ...EXTRA }] });
  const auths = getPerson(db, personId).details.authorisations;
  assert.equal(auths.length, 1);
  assert.equal(auths[0].country, "FR", "only the fully matching entry was removed");
});
