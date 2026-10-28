// Pliego T-V2-022 + RF-V2-007: xAI verification, distinct from mere
// configuration. A key being present ("configured") says nothing about
// whether it works; readiness requires a VERIFIED connection with a
// compatible model. Verification calls the provider's models endpoint
// (a cheap, non-generating call — no spend on generations) and records
// only a SHA-256 fingerprint of the key, never the key itself. A record
// is valid only for the exact key-fingerprint + model pair it was made
// for, so changing the key or the model invalidates it automatically.
// The fetch function is injectable so tests prove every outcome with a
// mocked provider: 401 rejection, network error, unverified state and
// an incompatible model must never yield readiness, and only a valid
// positive response does.
import { createHash, randomUUID } from "node:crypto";

export const DEFAULT_XAI_MODEL = "grok-4.20-non-reasoning";
export const XAI_MODELS_URL = "https://api.x.ai/v1/models";

/** SHA-256 fingerprint of a key (for matching verifications, never the key). */
export function keyFingerprint(key) {
  return createHash("sha256").update(String(key ?? "")).digest("hex");
}

/**
 * Verify a key + model against the provider's models endpoint.
 * @param {{fetchFn?: any, apiKey: string, model?: string}} opts
 * @returns {Promise<{ok: boolean, models: string[], reason: string | null}>}
 */
export async function verifyXaiConnection({ fetchFn = globalThis.fetch, apiKey, model = DEFAULT_XAI_MODEL }) {
  if (!apiKey) return { ok: false, models: [], reason: "no_key" };
  let res;
  try {
    res = await fetchFn(XAI_MODELS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    return { ok: false, models: [], reason: `network: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) return { ok: false, models: [], reason: "auth" };
    if (res.status === 429) return { ok: false, models: [], reason: "rate-limit" };
    return { ok: false, models: [], reason: `http_${res.status}` };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { ok: false, models: [], reason: "invalid_response" };
  }
  const models = Array.isArray(body?.data) ? body.data.map((m) => m.id).filter(Boolean) : [];
  if (!models.includes(model)) return { ok: false, models, reason: "model_not_available" };
  return { ok: true, models, reason: null };
}

/**
 * Record a verification attempt. Only the latest record per
 * fingerprint+model matters for isXaiVerified; history is kept.
 */
export function recordXaiVerification(db, { keyFingerprint: fingerprint, model, ok, models = [], reason = null }) {
  const id = randomUUID();
  db.prepare(
    "INSERT INTO xai_verifications (id, key_fingerprint, model, status, models_json, error) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, fingerprint, model, ok ? "ok" : "failed", JSON.stringify(models), reason);
  return id;
}

/** Delete all verification records (used when the key or model changes). */
export function clearXaiVerifications(db) {
  db.prepare("DELETE FROM xai_verifications").run();
}

/**
 * True only when the latest verification for this exact key
 * fingerprint + model pair succeeded. Anything else — no record, a
 * failed latest record, a different key, a different model — is not
 * verified, and must block readiness.
 */
export function isXaiVerified(db, { apiKey, model = DEFAULT_XAI_MODEL }) {
  if (!apiKey) return false;
  const row = db.prepare(
    "SELECT * FROM xai_verifications WHERE key_fingerprint = ? AND model = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).get(keyFingerprint(apiKey), model);
  return Boolean(row && row.status === "ok");
}

/** The model list from the latest successful verification, if any. */
export function lastVerifiedModels(db, { apiKey, model = DEFAULT_XAI_MODEL }) {
  const row = latestVerification(db, { apiKey, model });
  if (!row || row.status !== "ok") return [];
  try {
    return JSON.parse(row.models_json);
  } catch {
    return [];
  }
}

/** The latest verification record for this key fingerprint + model pair, or null. */
export function latestVerification(db, { apiKey, model = DEFAULT_XAI_MODEL }) {
  if (!apiKey) return null;
  return db.prepare(
    "SELECT * FROM xai_verifications WHERE key_fingerprint = ? AND model = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
  ).get(keyFingerprint(apiKey), model) ?? null;
}
