// R6 (G2 re-review): a deleted profile cannot create a new attempt —
// not from a stale tab, not from a direct API call. The backend
// validates profile state in both readiness and attempt creation, and
// creates no snapshot or attempt row. Historical attempts stay readable.
import test from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import { createProfileFull, archiveProfile, deleteProfile, profileReadiness, createAttempt, getAttempt } from "../packages/shared/profiles.mjs";
import { previewCv, confirmCvImport } from "../packages/shared/cv.mjs";
import { acceptPolicy, giveConsent } from "../packages/shared/policies.mjs";
import { createServer } from "../apps/server/server.mjs";
import { recordXaiVerification, keyFingerprint, DEFAULT_XAI_MODEL } from "../packages/shared/xai-verify.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-delattempt-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, FIXTURE_PERSON);
  return { db, personId };
}

function offer(db, id) {
  db.prepare("INSERT INTO offers (id, source, ats, canonical_url, title) VALUES (?, 'greenhouse', 'greenhouse', ?, 'Finance Manager')").run(id, `https://example.test/jobs/${id}`);
  return id;
}

async function readyProfile(db, personId) {
  const txt = fs.readFileSync(fileURLToPath(new URL("./fixtures/sample.txt", import.meta.url)));
  const preview = await previewCv(db, personId, "sample.txt", txt);
  confirmCvImport(db, preview.id);
  acceptPolicy(db, personId, "data_processing");
  giveConsent(db, personId, "apply_on_behalf");
  return createProfileFull(db, personId, "Finance", { focus: "Finance", cv_import_id: preview.id });
}

test("R6: readiness of a deleted profile is false, and attempt creation is rejected without side effects", async () => {
  const { db, personId } = setup();
  const profileId = await readyProfile(db, personId);
  const attemptId = createAttempt(db, personId, profileId, offer(db, "offer-r6-1"), { xaiVerified: true });
  assert.ok(getAttempt(db, attemptId), "the historical attempt exists");
  const attemptsBefore = db.prepare("SELECT COUNT(*) AS n FROM attempts").get().n;
  const snapshotsBefore = db.prepare("SELECT COUNT(*) AS n FROM person_snapshots").get().n;
  archiveProfile(db, profileId);
  deleteProfile(db, profileId);
  const readiness = profileReadiness(db, profileId, { xaiVerified: true });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.missing.includes("profile_deleted"));
  assert.throws(() => createAttempt(db, personId, profileId, offer(db, "offer-r6-2"), { xaiVerified: true }), /deleted/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM attempts").get().n, attemptsBefore, "no attempt row may be created");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM person_snapshots").get().n, snapshotsBefore, "no snapshot may be created");
  const kept = getAttempt(db, attemptId);
  assert.ok(kept && kept.personSnapshot, "the historical attempt and its snapshot stay readable");
});

test("R6: server rejects POST /api/attempts for a deleted profile with 400 and keeps history readable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-delserver-"));
  const { server, db, secrets } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const base = `http://127.0.0.1:${port}`;
  const post = async (path, body) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  try {
    const personRes = await post("/api/person", { ...FIXTURE_PERSON });
    const personId = personRes.json.id;
    const txt = fs.readFileSync(fileURLToPath(new URL("./fixtures/sample.txt", import.meta.url))).toString("base64");
    const cvRes = await post("/api/cv", { personId, filename: "sample.txt", contentBase64: txt });
    const cvId = cvRes.json.id;
    await post(`/api/cv/${cvId}/confirm`, {});
    const profileRes = await post("/api/profiles", { personId, name: "Finance", body: { focus: "Finance", cv_import_id: cvId } });
    const profileId = profileRes.json.id;
    await post("/api/policies/data_processing/accept", { personId });
    await post("/api/consents", { personId, key: "apply_on_behalf" });
    secrets.set("xai_api_key", "FAKE-DEL-XAI-KEY-ONLY");
    recordXaiVerification(db, { keyFingerprint: keyFingerprint("FAKE-DEL-XAI-KEY-ONLY"), model: DEFAULT_XAI_MODEL, ok: true, models: [DEFAULT_XAI_MODEL] });
    // Offers are not exposed via the API; insert the synthetic offers
    // directly, exactly as the other server tests do for fixtures.
    db.prepare("INSERT INTO offers (id, source, ats, canonical_url, title) VALUES ('offer-r6-s1', 'greenhouse', 'greenhouse', 'https://example.test/jobs/s1', 'Finance Manager')").run();
    db.prepare("INSERT INTO offers (id, source, ats, canonical_url, title) VALUES ('offer-r6-s2', 'greenhouse', 'greenhouse', 'https://example.test/jobs/s2', 'Finance Manager')").run();
    const first = await post("/api/attempts", { personId, profileId, offerId: "offer-r6-s1" });
    assert.equal(first.status, 201, `first attempt must succeed, got ${JSON.stringify(first.json)}`);
    await post(`/api/profiles/${profileId}/archive`, {});
    const del = await fetch(`${base}/api/profiles/${profileId}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    const stale = await post("/api/attempts", { personId, profileId, offerId: "offer-r6-s2" });
    assert.equal(stale.status, 400, "a stale tab / direct call with a deleted profile must be rejected");
    assert.match(stale.json.error, /deleted/);
    const kept = await fetch(`${base}/api/attempts/${first.json.id}`);
    assert.equal(kept.status, 200, "the historical attempt stays readable");
  } finally {
    server.close();
  }
});
