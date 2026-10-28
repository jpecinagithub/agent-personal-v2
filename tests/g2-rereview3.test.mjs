// G2 re-review 3 (2026-10-28): authorisation identity and deletion
// markers at module level. The browser tests in ui-browser.test.mjs
// cover the same behaviours through the screen; these pin the
// backend contract directly. Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull, updatePersonDetails, getPerson } from "../packages/shared/person.mjs";

function setup(authorisations) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-rereview3-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, {
    full_name: "Synthetic Original",
    email: "original@example.test",
    authorisations,
  });
  return { db, personId };
}

const LEGACY = { country: "ES", status: "authorised", valid_until: "2030-12", sponsorship_required: false };

test("authorisations: an identical id-less entry adopts the legacy entry and gains a stable id", () => {
  const { db, personId } = setup([LEGACY]);
  updatePersonDetails(db, personId, { authorisations: [{ ...LEGACY }] });
  let auths = getPerson(db, personId).details.authorisations;
  assert.equal(auths.length, 1, "adoption, not duplication");
  assert.ok(auths[0].id, "the adopted entry gains a stable id");
  assert.equal(auths[0].valid_until, "2030-12");
  assert.equal(auths[0].sponsorship_required, false);
  const adoptedId = auths[0].id;
  // Later saves address it by id and stay singular.
  updatePersonDetails(db, personId, { authorisations: [{ id: adoptedId, country: "ES", status: "authorised", valid_until: "2030-12", sponsorship_required: false }] });
  auths = getPerson(db, personId).details.authorisations;
  assert.equal(auths.length, 1);
  assert.equal(auths[0].id, adoptedId, "the id is stable across saves");
});

test("authorisations: an omitted sponsorship flag matches a stored false (checkbox semantics)", () => {
  const { db, personId } = setup([LEGACY]);
  // The form omits sponsorship_required when the box was never true;
  // that must still identify the stored entry whose flag is false.
  updatePersonDetails(db, personId, { authorisations: [{ country: "ES", status: "authorised", valid_until: "2030-12" }] });
  const auths = getPerson(db, personId).details.authorisations;
  assert.equal(auths.length, 1, "omitted sponsorship must not create a second entry");
  assert.ok(auths[0].id);
});

test("authorisations: same country with a different validity or sponsorship never adopts", () => {
  const { db, personId } = setup([LEGACY]);
  updatePersonDetails(db, personId, { authorisations: [{ country: "ES", status: "authorised", valid_until: "2031-01", sponsorship_required: false }] });
  let auths = getPerson(db, personId).details.authorisations;
  assert.equal(auths.length, 2, "different validity is a different entry, not a country merge");
  assert.equal(auths[0].valid_until, "2030-12", "the original is untouched");
  // Contract change (G2 re-review 4): legacy entries gain a persisted
  // id on load/creation, so the original now HAS an id — its fields
  // are what must stay untouched, not its id-lessness.
  assert.ok(auths[0].id, "the original gains a persisted id on load");
  updatePersonDetails(db, personId, { authorisations: [{ country: "ES", status: "authorised", valid_until: "2030-12", sponsorship_required: true }] });
  auths = getPerson(db, personId).details.authorisations;
  assert.equal(auths.length, 3, "different sponsorship is a different entry, not a country merge");
});

test("authorisations: an id-less deletion marker removes only the fully matching entry", () => {
  const { db, personId } = setup([
    LEGACY,
    { country: "FR", status: "authorised", valid_until: "2029-06", sponsorship_required: true },
  ]);
  updatePersonDetails(db, personId, { authorisations: [{ deleted: true, ...LEGACY }] });
  const auths = getPerson(db, personId).details.authorisations;
  assert.equal(auths.length, 1);
  assert.equal(auths[0].country, "FR", "only the fully matching entry was removed");
  // A marker that matches nothing removes nothing.
  updatePersonDetails(db, personId, { authorisations: [{ deleted: true, country: "DE", status: "authorised" }] });
  assert.equal(getPerson(db, personId).details.authorisations.length, 1, "a non-matching marker deletes nothing");
});
