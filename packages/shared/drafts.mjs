// Pliego T-V2-021: Profile drafts and versioning (snapshots). A configuration change is a
// draft until confirmed: drafts are edited freely and never touch the
// live profile. Confirming a draft, in ONE transaction, snapshots the
// current profile version, writes the draft body as the new version,
// records the effective date and links the new snapshot to the draft.
// Discarded drafts change nothing. A draft created from an older version
// cannot be confirmed after the profile moved on (stale base version).
import { randomUUID } from "node:crypto";
import { validateProfileBody, getProfileFull, assertValidProfileCv } from "./profiles.mjs";

export function createDraft(db, profileId) {
  const profile = getProfileFull(db, profileId);
  if (!profile) throw new Error("profile not found");
  if (profile.deleted) throw new Error("profile is deleted");
  const id = randomUUID();
  db.prepare("INSERT INTO profile_drafts (id, profile_id, base_version, body_json) VALUES (?, ?, ?, ?)").run(
    id, profileId, profile.version, JSON.stringify(profile.body),
  );
  return id;
}

export function getDraft(db, draftId) {
  const row = db.prepare("SELECT * FROM profile_drafts WHERE id = ?").get(draftId);
  if (!row) return null;
  return { ...row, body: JSON.parse(row.body_json) };
}

export function listDrafts(db, profileId) {
  return db.prepare("SELECT * FROM profile_drafts WHERE profile_id = ? ORDER BY created_at ASC").all(profileId).map((r) => ({
    ...r, body: JSON.parse(r.body_json),
  }));
}

export function updateDraft(db, draftId, body) {
  const valid = validateProfileBody(body);
  const r = db.prepare("UPDATE profile_drafts SET body_json = ? WHERE id = ? AND status = 'draft'").run(JSON.stringify(valid), draftId);
  if (r.changes === 0) throw new Error("draft not found or not editable");
}

export function discardDraft(db, draftId) {
  const r = db.prepare("UPDATE profile_drafts SET status = 'discarded' WHERE id = ? AND status = 'draft'").run(draftId);
  if (r.changes === 0) throw new Error("draft not found or not discardable");
}

/**
 * Confirm a draft: snapshot + profile update + draft confirmation in
 * one transaction. Returns the new snapshot id and effective date.
 */
export function confirmDraft(db, draftId) {
  const draft = getDraft(db, draftId);
  if (!draft) throw new Error("draft not found");
  if (draft.status !== "draft") throw new Error("only a draft in draft status can be confirmed");
  db.exec("BEGIN IMMEDIATE");
  try {
    const profile = getProfileFull(db, draft.profile_id);
    if (!profile) throw new Error("profile not found");
    if (profile.deleted) throw new Error("profile is deleted");
    if (profile.version !== draft.base_version) {
      throw new Error(`stale draft: profile is at version ${profile.version}, draft was based on ${draft.base_version}`);
    }
    // R4: a draft may only assign a confirmed CV of the same person.
    assertValidProfileCv(db, profile.person_id, draft.body.cv_import_id);
    // Preserve the replaced version's snapshot if it is not already
    // pinned (a pinned snapshot for this version must not be duplicated:
    // UNIQUE (profile_id, version)). Then write the new version and
    // snapshot the new body, so the confirmed change itself has a
    // snapshot with its effective date.
    const oldSnapshot = db.prepare("SELECT id FROM profile_snapshots WHERE profile_id = ? AND version = ?").get(draft.profile_id, profile.version);
    if (!oldSnapshot) {
      const oldId = randomUUID();
      db.prepare("INSERT INTO profile_snapshots (id, profile_id, version, body_json) VALUES (?, ?, ?, ?)").run(
        oldId, draft.profile_id, profile.version, JSON.stringify(profile.body),
      );
    }
    db.prepare("UPDATE profiles SET body_json = ?, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
      JSON.stringify(draft.body), draft.profile_id,
    );
    const snapshotId = randomUUID();
    db.prepare("INSERT INTO profile_snapshots (id, profile_id, version, body_json) VALUES (?, ?, ?, ?)").run(
      snapshotId, draft.profile_id, profile.version + 1, JSON.stringify(draft.body),
    );
    const effectiveAt = new Date().toISOString();
    db.prepare("UPDATE profile_drafts SET status = 'confirmed', snapshot_id = ?, effective_at = ?, confirmed_at = ? WHERE id = ?").run(
      snapshotId, effectiveAt, effectiveAt, draftId,
    );
    db.exec("COMMIT");
    return { snapshotId, effectiveAt };
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}
