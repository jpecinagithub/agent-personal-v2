// WHY THIS FILE EXISTS (user order 2026-10-28): the person form no
// longer shows or edits work authorisations — the "Autorizaciones de
// trabajo" section, its cards and its save handling were removed from
// apps/server/ui.html because, in the user's words, they add nothing
// to that form. The browser tests that drove authorisation cards
// through the form (G2 re-review 2/3/4 scenarios) therefore no longer
// describe anything the UI does, and were rewritten or removed.
//
// What must NOT be lost with them is the backend contract those tests
// also guarded: a save that does not mention authorisations — which
// is now exactly what every person-form save does — must preserve the
// stored authorisations exactly, with ids and extra fields intact.
// Backend edit/delete-by-id behaviour stays covered by the module
// tests in g2-rereview3.test.mjs and g2-rereview4.test.mjs; this file
// covers only the form-save preservation contract, at API/module
// level, with synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull, updatePersonDetails, getPerson } from "../packages/shared/person.mjs";

test("form-equivalent save without an authorisations field preserves stored authorisations exactly across repeated saves", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-form-auth-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  // The user's exact G2 re-review 4 fixture, without an id (legacy).
  const personId = createPersonFull(db, {
    full_name: "Synthetic Original",
    email: "original@example.test",
    authorisations: [
      { country: "ES", status: "authorised", valid_until: "2030-12", sponsorship_required: false, valid_from: "2025-01", source_note: "Synthetic user declaration" },
      { country: "FR", status: "authorised", valid_until: "2029-06", sponsorship_required: true },
    ],
  });
  // First read normalises: legacy entries gain persisted stable ids.
  const first = getPerson(db, personId).details.authorisations;
  assert.equal(first.length, 2);
  assert.ok(first[0].id && first[1].id, "legacy entries gained persisted ids on read");
  assert.notEqual(first[0].id, first[1].id, "distinct entries keep distinct ids");
  // Three form-equivalent saves: each patch touches another field and
  // never mentions authorisations, exactly as personDetailsFromForm
  // now behaves after the authorisations section was removed.
  // (Split 2026-10-29: the patch field is links, a person field —
  // skills now live on profiles and a person patch with skills is
  // rejected, so it can no longer serve as the "other field" here.)
  for (let round = 0; round < 3; round++) {
    updatePersonDetails(db, personId, { links: [`https://example.test/profile-${round}`] });
    const after = getPerson(db, personId).details;
    assert.deepEqual(after.authorisations, first, `round ${round}: stored authorisations byte-identical`);
    assert.equal(after.authorisations[0].valid_from, "2025-01", "extra field preserved");
    assert.equal(after.authorisations[0].source_note, "Synthetic user declaration", "extra field preserved");
    assert.deepEqual(after.links, [`https://example.test/profile-${round}`], "the patch itself still applied");
  }
});

test("form-equivalent save preserves a single legacy authorisation without duplicating it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-form-auth-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, {
    full_name: "Synthetic Original",
    email: "original@example.test",
    authorisations: [
      { country: "ES", status: "authorised", valid_until: "2030-12", sponsorship_required: false },
    ],
  });
  const before = getPerson(db, personId).details.authorisations;
  assert.equal(before.length, 1);
  updatePersonDetails(db, personId, { display_name: "Synthetic Renamed" });
  const after = getPerson(db, personId).details;
  assert.equal(after.authorisations.length, 1, "no 1 -> 2 duplication from a save that omits authorisations");
  assert.deepEqual(after.authorisations, before);
});
