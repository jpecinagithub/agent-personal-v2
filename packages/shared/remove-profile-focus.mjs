// Migration 010 (user order 2026-10-29): delete the profile "focus"
// (enfoque) field entirely. The profile name (Finance Manager, AI
// Engineer, ...) is enough to identify a profile, and focus is no
// longer a readiness requirement.
//   - Drops the `focus` column from `profiles` when present (a no-op
//     on databases created after this change, which never have it).
//   - Strips any `focus` key from every profile's `body_json`, and
//     from in-flight draft bodies too, so confirming an old draft
//     cannot reintroduce the deleted key.
//   - Profile snapshots are deliberately NOT rewritten: snapshots are
//     immutable history, and a focus key inside an old snapshot is
//     dead data that no code reads any more.
// Idempotent: a second run finds no column and no keys, and changes
// nothing.
export function removeProfileFocus(db) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
  );
  if (tables.has("profiles")) {
    const cols = db.prepare("PRAGMA table_info(profiles)").all();
    if (cols.some((c) => c.name === "focus")) {
      db.exec("ALTER TABLE profiles DROP COLUMN focus;");
    }
    stripFocusKey(db, "profiles");
  }
  if (tables.has("profile_drafts")) {
    stripFocusKey(db, "profile_drafts");
  }
}

/** @param {any} db @param {string} table */
function stripFocusKey(db, table) {
  for (const row of db.prepare(`SELECT id, body_json FROM ${table}`).all()) {
    let body;
    try {
      body = JSON.parse(row.body_json);
    } catch {
      continue;
    }
    if (body && typeof body === "object" && "focus" in body) {
      delete body.focus;
      db.prepare(`UPDATE ${table} SET body_json = ? WHERE id = ?`).run(JSON.stringify(body), row.id);
    }
  }
}
