// T-V2-017: Drafts and versioning.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import { createProfileFull, getProfileFull } from "../packages/shared/profiles.mjs";
import { createDraft, getDraft, updateDraft, discardDraft, confirmDraft } from "../packages/shared/drafts.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-draft-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, FIXTURE_PERSON);
  const profileId = createProfileFull(db, personId, "Finance", { focus: "Finance v1" });
  return { db, profileId };
}

test("a draft never touches the live profile until confirmed", () => {
  const { db, profileId } = setup();
  const draftId = createDraft(db, profileId);
  updateDraft(db, draftId, { focus: "Finance v2" });
  assert.equal(getProfileFull(db, profileId).body.focus, "Finance v1");
  assert.equal(getProfileFull(db, profileId).version, 1);
  const { snapshotId, effectiveAt } = confirmDraft(db, draftId);
  assert.ok(effectiveAt);
  const profile = getProfileFull(db, profileId);
  assert.equal(profile.body.focus, "Finance v2");
  assert.equal(profile.version, 2);
  const snap = db.prepare("SELECT * FROM profile_snapshots WHERE id = ?").get(snapshotId);
  assert.equal(snap.version, 2);
  assert.equal(JSON.parse(String(snap.body_json)).focus, "Finance v2");
  assert.equal(getDraft(db, draftId).status, "confirmed");
});

test("a discarded draft changes nothing and cannot be confirmed", () => {
  const { db, profileId } = setup();
  const draftId = createDraft(db, profileId);
  updateDraft(db, draftId, { focus: "Finance v2" });
  discardDraft(db, draftId);
  assert.equal(getDraft(db, draftId).status, "discarded");
  assert.equal(getProfileFull(db, profileId).body.focus, "Finance v1");
  assert.throws(() => confirmDraft(db, draftId), /only a draft in draft status/);
});

test("a stale draft cannot be confirmed after the profile moved on", () => {
  const { db, profileId } = setup();
  const first = createDraft(db, profileId);
  const stale = createDraft(db, profileId);
  updateDraft(db, first, { focus: "Finance v2" });
  confirmDraft(db, first);
  assert.equal(getProfileFull(db, profileId).version, 2);
  updateDraft(db, stale, { focus: "Finance v3" });
  assert.throws(() => confirmDraft(db, stale), /stale draft/);
  assert.equal(getProfileFull(db, profileId).body.focus, "Finance v2");
});

test("draft bodies reject unknown fields", () => {
  const { db, profileId } = setup();
  const draftId = createDraft(db, profileId);
  assert.throws(() => updateDraft(db, draftId, { invented: true }), /unknown profile field/);
});
