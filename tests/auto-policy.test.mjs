// R5 (G2 re-review, RF-V2-008): automatic mode requires a persisted,
// bounded policy — daily limit, profiles, sources and conditions.
// Generic consent text never substitutes for it. Deactivation is
// always immediately available. Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import { createProfileFull, profileReadiness } from "../packages/shared/profiles.mjs";
import { validateAutoPolicy, getAutoPolicy, setAutoPolicy, acceptPolicy, giveConsent, getSetting } from "../packages/shared/policies.mjs";
import { previewCv, confirmCvImport } from "../packages/shared/cv.mjs";
import { createDraft, updateDraft, confirmDraft } from "../packages/shared/drafts.mjs";
import { createServer } from "../apps/server/server.mjs";
import { recordXaiVerification, keyFingerprint, DEFAULT_XAI_MODEL } from "../packages/shared/xai-verify.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-autopolicy-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, FIXTURE_PERSON);
  const profileId = createProfileFull(db, personId, "Finance", { focus: "Finance" });
  return { db, personId, profileId };
}

test("R5: each missing policy field is reported by name", () => {
  const { db } = setup();
  assert.deepEqual(validateAutoPolicy(db, null), ["daily_limit", "profile_ids", "sources", "conditions"]);
  assert.deepEqual(validateAutoPolicy(db, { daily_limit: 0, profile_ids: [], sources: [], conditions: "" }), ["daily_limit", "profile_ids", "sources", "conditions"]);
  assert.deepEqual(validateAutoPolicy(db, { daily_limit: 5, profile_ids: ["no-such-profile"], sources: ["greenhouse"], conditions: "x" }), ["profile_ids"]);
  assert.deepEqual(validateAutoPolicy(db, { daily_limit: 5, profile_ids: [], sources: ["greenhouse"], conditions: "x" }), ["profile_ids"]);
  assert.deepEqual(validateAutoPolicy(db, { daily_limit: 5, profile_ids: ["x"], sources: [], conditions: "x" }).length, 2, "unknown profile and empty sources both fail");
});

test("R5: a valid policy stores; an incomplete one is refused", async () => {
  const { db, personId, profileId } = setup();
  assert.throws(() => setAutoPolicy(db, { daily_limit: 5, profile_ids: [profileId], sources: [], conditions: "x" }), /missing sources/);
  assert.equal(getAutoPolicy(db), null);
  const policy = { daily_limit: 5, profile_ids: [profileId], sources: ["greenhouse"], conditions: "remote only" };
  setAutoPolicy(db, policy);
  assert.deepEqual(getAutoPolicy(db), policy);
});

async function startServerWithVerifiedXai() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-autoserver-"));
  const { server, db, secrets } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  return { server, db, secrets, base: `http://127.0.0.1:${port}` };
}

async function post(base, path, body) {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

test("R5: server activation without a policy is rejected with the missing fields; a valid policy activates; deactivation is always available", async () => {
  const { server, db, secrets, base } = await startServerWithVerifiedXai();
  try {
    // Build a ready profile through the API, with xAI verified via a
    // recorded verification (mocked provider state, no real call).
    const personRes = await post(base, "/api/person", { ...FIXTURE_PERSON });
    assert.equal(personRes.status, 201);
    const personId = personRes.json.id;
    const txt = fs.readFileSync(new URL("./fixtures/sample.txt", import.meta.url).pathname).toString("base64");
    const cvRes = await post(base, "/api/cv", { personId, filename: "sample.txt", contentBase64: txt });
    const cvId = cvRes.json.id;
    await post(base, `/api/cv/${cvId}/confirm`, {});
    const profileRes = await post(base, "/api/profiles", { personId, name: "Finance", body: { focus: "Finance", cv_import_id: cvId } });
    const profileId = profileRes.json.id;
    await post(base, "/api/policies/data_processing/accept", { personId });
    await post(base, "/api/consents", { personId, key: "apply_on_behalf" });
    secrets.set("xai_api_key", "FAKE-AUTO-XAI-KEY-ONLY");
    recordXaiVerification(db, { keyFingerprint: keyFingerprint("FAKE-AUTO-XAI-KEY-ONLY"), model: DEFAULT_XAI_MODEL, ok: true, models: [DEFAULT_XAI_MODEL] });
    const readiness = await (await fetch(`${base}/api/profiles/${profileId}/readiness`)).json();
    assert.equal(readiness.ready, true, `profile must be ready, missing: ${readiness.missing.join(", ")}`);
    // Generic consent alone does not activate: no policy exists yet.
    await post(base, "/api/consents", { personId, key: "auto_apply" });
    const blocked = await post(base, "/api/settings", { key: "auto_mode", value: "on" });
    assert.equal(blocked.status, 400);
    assert.match(blocked.json.error, /daily_limit/);
    assert.match(blocked.json.error, /profile_ids/);
    // Each missing field on save is explained too.
    const badPolicy = await post(base, "/api/auto-policy", { policy: { daily_limit: 5, profile_ids: [profileId], sources: [], conditions: "x" } });
    assert.equal(badPolicy.status, 400);
    assert.match(badPolicy.json.error, /sources/);
    // A valid policy activates.
    const saved = await post(base, "/api/auto-policy", { policy: { daily_limit: 5, profile_ids: [profileId], sources: ["greenhouse"], conditions: "remote only" } });
    assert.equal(saved.status, 200);
    const enabled = await post(base, "/api/settings", { key: "auto_mode", value: "on" });
    assert.equal(enabled.status, 200);
    assert.equal((await (await fetch(`${base}/api/settings`)).json()).auto_mode, "on");
    // Deactivation is always immediately available.
    const disabled = await post(base, "/api/settings", { key: "auto_mode", value: "off" });
    assert.equal(disabled.status, 200);
    assert.equal((await (await fetch(`${base}/api/settings`)).json()).auto_mode, "off");
  } finally {
    server.close();
  }
});
