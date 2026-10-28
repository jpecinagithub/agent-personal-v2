// R3 (G2 re-review): a configured xAI key is not a verified xAI.
// Verification is proved with a MOCKED provider: no real keys, no real
// calls, no spend. 401, network errors, unverified state and an
// incompatible model must never yield readiness; only a valid positive
// response does. Changing the key or the model invalidates verification.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { verifyXaiConnection, recordXaiVerification, clearXaiVerifications, isXaiVerified, keyFingerprint, DEFAULT_XAI_MODEL } from "../packages/shared/xai-verify.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-xaiverify-"));
  return openDatabase(path.join(dir, "agentv2.db"));
}

function mockFetch({ ok = true, status = 200, body = {}, throws = null } = {}) {
  return async () => {
    if (throws) throw new Error(throws);
    return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

const MODELS = { data: [{ id: DEFAULT_XAI_MODEL }, { id: "grok-4.7" }] };

test("R3: 401 rejection is not verified", async () => {
  const r = await verifyXaiConnection({ fetchFn: mockFetch({ ok: false, status: 401 }), apiKey: "FAKE-KEY-ONLY", model: DEFAULT_XAI_MODEL });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "auth");
});

test("R3: a network error is not verified", async () => {
  const r = await verifyXaiConnection({ fetchFn: mockFetch({ throws: "socket hangup" }), apiKey: "FAKE-KEY-ONLY", model: DEFAULT_XAI_MODEL });
  assert.equal(r.ok, false);
  assert.match(r.reason, /network/);
});

test("R3: a model list without the selected model is not verified", async () => {
  const r = await verifyXaiConnection({ fetchFn: mockFetch({ body: { data: [{ id: "some-other-model" }] } }), apiKey: "FAKE-KEY-ONLY", model: DEFAULT_XAI_MODEL });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "model_not_available");
});

test("R3: a valid positive response verifies, and only for that key and model", async () => {
  const db = setup();
  const r = await verifyXaiConnection({ fetchFn: mockFetch({ body: MODELS }), apiKey: "FAKE-KEY-ONLY", model: DEFAULT_XAI_MODEL });
  assert.equal(r.ok, true);
  assert.deepEqual(r.models, [DEFAULT_XAI_MODEL, "grok-4.7"]);
  recordXaiVerification(db, { keyFingerprint: keyFingerprint("FAKE-KEY-ONLY"), model: DEFAULT_XAI_MODEL, ok: true, models: r.models });
  assert.equal(isXaiVerified(db, { apiKey: "FAKE-KEY-ONLY", model: DEFAULT_XAI_MODEL }), true);
  assert.equal(isXaiVerified(db, { apiKey: "A-DIFFERENT-FAKE-KEY", model: DEFAULT_XAI_MODEL }), false, "changing the key invalidates verification");
  assert.equal(isXaiVerified(db, { apiKey: "FAKE-KEY-ONLY", model: "grok-4.7" }), false, "changing the model invalidates verification");
  assert.equal(isXaiVerified(db, { apiKey: null, model: DEFAULT_XAI_MODEL }), false, "no key is never verified");
});

test("R3: a later failed verification revokes, and clearing removes verification", async () => {
  const db = setup();
  recordXaiVerification(db, { keyFingerprint: keyFingerprint("FAKE-KEY-ONLY"), model: DEFAULT_XAI_MODEL, ok: true, models: [DEFAULT_XAI_MODEL] });
  assert.equal(isXaiVerified(db, { apiKey: "FAKE-KEY-ONLY", model: DEFAULT_XAI_MODEL }), true);
  recordXaiVerification(db, { keyFingerprint: keyFingerprint("FAKE-KEY-ONLY"), model: DEFAULT_XAI_MODEL, ok: false, reason: "auth" });
  assert.equal(isXaiVerified(db, { apiKey: "FAKE-KEY-ONLY", model: DEFAULT_XAI_MODEL }), false, "the latest record decides");
  recordXaiVerification(db, { keyFingerprint: keyFingerprint("FAKE-KEY-ONLY"), model: DEFAULT_XAI_MODEL, ok: true, models: [DEFAULT_XAI_MODEL] });
  clearXaiVerifications(db);
  assert.equal(isXaiVerified(db, { apiKey: "FAKE-KEY-ONLY", model: DEFAULT_XAI_MODEL }), false);
});

test("xAI: a pasted key with surrounding whitespace is trimmed before sending", async () => {
  let sentAuth = null;
  const fetchFn = async (url, opts) => {
    sentAuth = opts.headers.Authorization;
    return { ok: true, status: 200, json: async () => MODELS };
  };
  const r = await verifyXaiConnection({ fetchFn, apiKey: "  FAKE-KEY-ONLY\n", model: DEFAULT_XAI_MODEL });
  assert.equal(r.ok, true);
  assert.equal(sentAuth, "Bearer FAKE-KEY-ONLY");
});
