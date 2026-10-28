// F1 server: private deployment only. Binds to 127.0.0.1 by default and
// refuses any non-loopback host. No login, no roles (constitution). The
// secrets endpoint lists names only; values never leave this process in
// a response.
import http from "node:http";
import path from "node:path";
import { openDatabase } from "../../packages/shared/db.mjs";
import { enqueue, claim, complete, fail, pauseJob, resumeJob, cancelJob, recover, getJob } from "../../packages/shared/queue.mjs";
import { appendEvent, listEvents, subscribe } from "../../packages/shared/events.mjs";
import { SecretStore } from "../../packages/shared/secrets.mjs";
import { isAllowedControlOrigin } from "../../packages/shared/guard.mjs";
// F2: person, profiles, drafts, facts, resolution, mappings, UI config.
import fs from "node:fs";
import { createPersonFull, updatePersonDetails, getPerson, listPersons } from "../../packages/shared/person.mjs";
import { createProfileFull, listProfiles, getProfileFull, archiveProfile, unarchiveProfile, deleteProfile, duplicateProfile, profileReadiness, createAttempt, getAttempt } from "../../packages/shared/profiles.mjs";
import { createDraft, getDraft, listDrafts, updateDraft, discardDraft, confirmDraft } from "../../packages/shared/drafts.mjs";
import { declareFact, listFacts } from "../../packages/shared/facts.mjs";
import { resolveScreening, answerPendingQuestion, listPendingQuestions } from "../../packages/shared/resolve.mjs";
import { defineMapping, getMapping, listMappings } from "../../packages/shared/mappings.mjs";
// F2 corrections: CV importer, policies/consents/settings.
import { previewCv, listCvImports, getCvImport, confirmCvImport, rejectCvImport, correctProposal } from "../../packages/shared/cv.mjs";
import { listPolicies, listConsents, giveConsent, acceptPolicy, hasConsent, getSetting, setSetting, getAutoPolicy, setAutoPolicy, validateAutoPolicy } from "../../packages/shared/policies.mjs";
// G2 re-review: xAI verification (R3) — configured is not verified.
import { verifyXaiConnection, recordXaiVerification, clearXaiVerifications, isXaiVerified, latestVerification, lastVerifiedModels, keyFingerprint, DEFAULT_XAI_MODEL } from "../../packages/shared/xai-verify.mjs";

/**
 * @param {{dataDir: string, port?: number, recoverIntervalMs?: number, verifyFetchFn?: any}} opts
 * verifyFetchFn is injected only for the xAI verify route so tests can
 * prove verification against a mocked provider (never a real call).
 */
export function createServer({ dataDir, port = 0, recoverIntervalMs = 30000, verifyFetchFn = globalThis.fetch }) {
  const db = openDatabase(path.join(dataDir, "agentv2.db"));
  recover(db);
  // Periodic recovery sweep: a lease that expires AFTER a restart is
  // recovered automatically when it expires, without another restart.
  // The timer is stopped when the HTTP server closes (see below).
  const recoveryTimer = setInterval(() => {
    try {
      recover(db);
    } catch {
      // A sweep must never crash the server; the next sweep retries.
    }
  }, recoverIntervalMs);
  if (typeof recoveryTimer.unref === "function") recoveryTimer.unref();
  const secrets = new SecretStore(path.join(dataDir, "secrets.json"));
  // xAI for readiness (RF-V2-020, R3): "configured" (a key exists) is
  // NOT "verified" (a successful connection + model check for this exact
  // key + model). Readiness requires verified. The key value is never
  // returned to the UI, only booleans and the model list (see
  // /api/xai-status).
  const xaiKey = () => secrets.get("xai_api_key") ?? process.env.XAI_API_KEY ?? null;
  const xaiConfigured = () => Boolean(xaiKey());
  const xaiModel = () => getSetting(db, "xai_model") ?? DEFAULT_XAI_MODEL;
  const xaiVerified = () => isXaiVerified(db, { apiKey: xaiKey(), model: xaiModel() });
  const xaiStatus = () => {
    const key = xaiKey();
    const model = xaiModel();
    const latest = latestVerification(db, { apiKey: key, model });
    return {
      configured: Boolean(key),
      verified: xaiVerified(),
      model,
      models: lastVerifiedModels(db, { apiKey: key, model }),
      verified_at: latest && latest.status === "ok" ? latest.created_at : null,
      error: latest && latest.status !== "ok" ? latest.error : null,
    };
  };

  const readJson = (req) => new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(new Error("invalid JSON")); }
    });
  });
  const send = (res, status, obj) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  // Control-channel origin check, applied to EVERY state-changing route,
  // not just /control/ping: a foreign Origin gets 403 and changes nothing.
  // Reads (health, events, secrets names, single job) are not commands and
  // keep the previous behaviour. Requests with no Origin (same-origin
  // server-side callers, curl) pass, as before.
  const requireControlOrigin = (req, res) => {
    const address = server.address();
    const ownOrigin = typeof address === "object" && address !== null ? `http://127.0.0.1:${address.port}` : "";
    if (!isAllowedControlOrigin(req.headers.origin, ownOrigin)) {
      send(res, 403, { error: "foreign origin rejected" });
      return false;
    }
    return true;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/secrets") return send(res, 200, { names: secrets.list() });
      if (req.method === "GET" && url.pathname === "/events") {
        const since = Number(url.searchParams.get("since") ?? req.headers["last-event-id"] ?? 0);
        const events = listEvents(db, Number.isFinite(since) ? since : 0);
        if (req.headers.accept === "text/event-stream") {
          res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          // Flush headers immediately: with no history to write, the client
          // would otherwise wait forever for the first chunk (writeHead
          // alone does not flush). This is what makes a live-first
          // connection possible at all.
          res.flushHeaders();
          for (const e of events) res.write(`id: ${e.seq}\ndata: ${JSON.stringify({ type: e.type, payload: e.payload })}\n\n`);
          // Live publication: events appended after this client connected
          // are pushed over the open connection, not only replayed history.
          const push = (event) => {
            try {
              res.write(`id: ${event.seq}\ndata: ${JSON.stringify({ type: event.type, payload: event.payload })}\n\n`);
            } catch {
              // Client went away; the close handler unsubscribes.
            }
          };
          const unsubscribe = subscribe(db, push);
          res.on("close", unsubscribe);
          return;
        }
        return send(res, 200, { events });
      }
      if (req.method === "POST" && url.pathname === "/control/ping") {
        if (!requireControlOrigin(req, res)) return;
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/queue/enqueue") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        const id = enqueue(db, body.kind ?? "job", body.payload ?? {});
        appendEvent(db, "job.enqueued", { jobId: id, kind: body.kind ?? "job" });
        return send(res, 201, { id });
      }
      if (req.method === "POST" && url.pathname === "/queue/claim") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        const job = claim(db, body.workerId ?? "worker", body.leaseMs ?? 60000);
        return send(res, 200, { job });
      }
      if (req.method === "POST" && url.pathname === "/queue/complete") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        complete(db, body.jobId, body.token, body.result ?? {});
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/queue/fail") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        fail(db, body.jobId, body.token, body.result ?? {});
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/queue/pause") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        pauseJob(db, body.jobId);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/queue/resume") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        resumeJob(db, body.jobId);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/queue/cancel") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        cancelJob(db, body.jobId);
        return send(res, 200, { ok: true });
      }
      // F2 UI: a single static page, no build step, served by this
      // server. It never touches /secrets: secret values are never
      // part of the configuration UI (names only exist in F1's API).
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/ui")) {
        const html = fs.readFileSync(new URL("./ui.html", import.meta.url), "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      // F2 API. Reads are plain GETs (as in F1); every state-changing
      // route requires the control origin, so a foreign web page cannot
      // issue commands to this private portal.
      if (req.method === "POST" && url.pathname === "/api/person") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        const existing = listPersons(db);
        const id = existing.length > 0 ? (updatePersonDetails(db, existing[0].id, body), existing[0].id) : createPersonFull(db, body);
        return send(res, 201, { id, person: getPerson(db, id) });
      }
      if (req.method === "GET" && url.pathname === "/api/person") {
        const persons = listPersons(db);
        return send(res, 200, { person: persons[0] ?? null });
      }
      if (req.method === "POST" && url.pathname === "/api/profiles") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        const id = createProfileFull(db, body.personId, body.name, body.body ?? {});
        return send(res, 201, { id, profile: getProfileFull(db, id) });
      }
      if (req.method === "GET" && url.pathname === "/api/profiles") {
        return send(res, 200, { profiles: listProfiles(db, url.searchParams.get("personId") ?? "") });
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/profiles/") && url.pathname.endsWith("/readiness")) {
        const profileId = url.pathname.split("/")[3];
        return send(res, 200, profileReadiness(db, profileId, { xaiVerified: xaiVerified() }));
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/profiles/") && url.pathname.endsWith("/duplicate")) {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        const id = duplicateProfile(db, url.pathname.split("/")[3], body.name);
        return send(res, 201, { id, profile: getProfileFull(db, id) });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/profiles/") && url.pathname.endsWith("/archive")) {
        if (!requireControlOrigin(req, res)) return;
        archiveProfile(db, url.pathname.split("/")[3]);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/profiles/") && url.pathname.endsWith("/unarchive")) {
        if (!requireControlOrigin(req, res)) return;
        unarchiveProfile(db, url.pathname.split("/")[3]);
        return send(res, 200, { ok: true });
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/api/profiles/")) {
        if (!requireControlOrigin(req, res)) return;
        deleteProfile(db, url.pathname.split("/")[3]);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/profiles/") && url.pathname.endsWith("/drafts")) {
        if (!requireControlOrigin(req, res)) return;
        const id = createDraft(db, url.pathname.split("/")[3]);
        return send(res, 201, { id, draft: getDraft(db, id) });
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/profiles/") && url.pathname.endsWith("/drafts")) {
        return send(res, 200, { drafts: listDrafts(db, url.pathname.split("/")[3]) });
      }
      if (req.method === "PUT" && url.pathname.startsWith("/api/drafts/")) {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        updateDraft(db, url.pathname.split("/")[3], body.body ?? {});
        return send(res, 200, { draft: getDraft(db, url.pathname.split("/")[3]) });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/drafts/") && url.pathname.endsWith("/confirm")) {
        if (!requireControlOrigin(req, res)) return;
        const result = confirmDraft(db, url.pathname.split("/")[3]);
        return send(res, 200, result);
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/drafts/") && url.pathname.endsWith("/discard")) {
        if (!requireControlOrigin(req, res)) return;
        discardDraft(db, url.pathname.split("/")[3]);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/facts") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        const id = declareFact(db, { personId: body.personId, concept: body.concept, scope: body.scope ?? "", value: body.value, provenance: body.provenance ?? "user", confirmationState: body.confirmationState ?? "confirmed" });
        return send(res, 201, { id });
      }
      if (req.method === "GET" && url.pathname === "/api/facts") {
        return send(res, 200, { facts: listFacts(db, url.searchParams.get("personId") ?? "") });
      }
      if (req.method === "POST" && url.pathname === "/api/resolve") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        return send(res, 200, { answers: resolveScreening(db, body.personId, body.questions ?? []) });
      }
      if (req.method === "GET" && url.pathname === "/api/questions") {
        return send(res, 200, { questions: listPendingQuestions(db, url.searchParams.get("personId") ?? "") });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/questions/") && url.pathname.endsWith("/answer")) {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        const factId = answerPendingQuestion(db, url.pathname.split("/")[3], body.value, body.provenance ?? "user");
        return send(res, 200, { factId });
      }
      if (req.method === "POST" && url.pathname === "/api/mappings") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        const id = defineMapping(db, { source: body.source, fieldKey: body.fieldKey, sourceField: body.sourceField });
        return send(res, 201, { id });
      }
      if (req.method === "GET" && url.pathname === "/api/mappings") {
        const source = url.searchParams.get("source");
        const fieldKey = url.searchParams.get("fieldKey");
        if (source && fieldKey) return send(res, 200, { sourceField: getMapping(db, source, fieldKey) });
        return send(res, 200, { mappings: listMappings(db, source ?? undefined) });
      }
      if (req.method === "POST" && url.pathname === "/api/attempts") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        const id = createAttempt(db, body.personId, body.profileId, body.offerId, { xaiVerified: xaiVerified() });
        return send(res, 201, { id, attempt: getAttempt(db, id) });
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/attempts/")) {
        const attempt = getAttempt(db, url.pathname.split("/")[3]);
        if (!attempt) return send(res, 404, { error: "attempt not found" });
        return send(res, 200, { attempt });
      }
      // F2 corrections: CV importer (T-V2-016). The upload is JSON with a
      // base64 file body so the UI file input needs no multipart parser;
      // the browser test uses the same route through the file input.
      if (req.method === "POST" && url.pathname === "/api/cv") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        if (typeof body.contentBase64 !== "string") throw new Error("contentBase64 is required");
        const buffer = Buffer.from(body.contentBase64, "base64");
        const preview = await previewCv(db, body.personId, body.filename ?? "cv", buffer);
        return send(res, 201, preview);
      }
      if (req.method === "GET" && url.pathname === "/api/cv") {
        return send(res, 200, { imports: listCvImports(db, url.searchParams.get("personId") ?? "") });
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/cv/")) {
        const cv = getCvImport(db, url.pathname.split("/")[3]);
        if (!cv) return send(res, 404, { error: "CV import not found" });
        return send(res, 200, { cv });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/cv/") && url.pathname.endsWith("/confirm")) {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        return send(res, 200, confirmCvImport(db, url.pathname.split("/")[3], { resolutions: body.resolutions ?? {} }));
      }
      if (req.method === "PUT" && url.pathname.includes("/proposals/")) {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        const parts = url.pathname.split("/");
        const corrected = correctProposal(db, parts[5], body.value);
        if (corrected.cv_import_id !== parts[3]) throw new Error("proposal does not belong to this CV import");
        return send(res, 200, { proposal: corrected });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/cv/") && url.pathname.endsWith("/reject")) {
        if (!requireControlOrigin(req, res)) return;
        return send(res, 200, rejectCvImport(db, url.pathname.split("/")[3]));
      }
      // F2 corrections: policies, consents, xAI status/key, settings
      // (T-V2-022, RF-V2-007, RF-V2-008, RF-V2-020).
      if (req.method === "GET" && url.pathname === "/api/policies") {
        return send(res, 200, { policies: listPolicies(db) });
      }
      if (req.method === "POST" && url.pathname.startsWith("/api/policies/") && url.pathname.endsWith("/accept")) {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        const id = acceptPolicy(db, body.personId, url.pathname.split("/")[3]);
        return send(res, 200, { id });
      }
      if (req.method === "GET" && url.pathname === "/api/consents") {
        return send(res, 200, { consents: listConsents(db, url.searchParams.get("personId") ?? "") });
      }
      if (req.method === "POST" && url.pathname === "/api/consents") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        const id = giveConsent(db, body.personId, body.key);
        return send(res, 200, { id });
      }
      if (req.method === "GET" && url.pathname === "/api/xai-status") {
        return send(res, 200, xaiStatus());
      }
      if (req.method === "POST" && url.pathname === "/api/xai-key") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        if (typeof body.value !== "string" || !body.value) throw new Error("xAI key value is required");
        secrets.set("xai_api_key", body.value);
        // A new key invalidates any previous verification (R3).
        clearXaiVerifications(db);
        return send(res, 200, xaiStatus());
      }
      if (req.method === "POST" && url.pathname === "/api/xai-model") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        if (typeof body.model !== "string" || !body.model.trim()) throw new Error("xAI model is required");
        setSetting(db, "xai_model", body.model.trim());
        // A new model invalidates any previous verification (R3).
        clearXaiVerifications(db);
        return send(res, 200, xaiStatus());
      }
      if (req.method === "POST" && url.pathname === "/api/xai-verify") {
        if (!requireControlOrigin(req, res)) return;
        const key = xaiKey();
        if (!key) throw new Error("xAI key is not configured: save a key before verifying");
        const model = xaiModel();
        const result = await verifyXaiConnection({ fetchFn: verifyFetchFn, apiKey: key, model });
        recordXaiVerification(db, { keyFingerprint: keyFingerprint(key), model, ok: result.ok, models: result.models, reason: result.reason });
        return send(res, 200, { ...result, status: xaiStatus() });
      }
      if (req.method === "GET" && url.pathname === "/api/auto-policy") {
        const policy = getAutoPolicy(db);
        return send(res, 200, { policy, missing: policy ? validateAutoPolicy(db, policy) : ["daily_limit", "profile_ids", "sources", "conditions"] });
      }
      if (req.method === "POST" && url.pathname === "/api/auto-policy") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        const policy = setAutoPolicy(db, body.policy ?? body);
        return send(res, 200, { policy });
      }
      if (req.method === "GET" && url.pathname === "/api/settings") {
        const policy = getAutoPolicy(db);
        return send(res, 200, {
          auto_mode: getSetting(db, "auto_mode") ?? "off",
          auto_policy: policy,
          auto_policy_missing: policy ? validateAutoPolicy(db, policy) : ["daily_limit", "profile_ids", "sources", "conditions"],
        });
      }
      if (req.method === "POST" && url.pathname === "/api/settings") {
        if (!requireControlOrigin(req, res)) return;
        const body = await readJson(req);
        if (body.key === "auto_mode" && body.value === "on") {
          // R5 (RF-V2-008): enabling automatic mode requires a
          // persisted, complete auto-apply policy AND at least one of
          // the policy's profiles ready. Accepting a generic consent
          // text does not substitute for the policy. It can always be
          // disabled immediately.
          const policy = getAutoPolicy(db);
          const missing = policy ? validateAutoPolicy(db, policy) : ["daily_limit", "profile_ids", "sources", "conditions"];
          if (missing.length > 0) {
            throw new Error(`cannot enable automatic mode: the auto-apply policy is incomplete, missing ${missing.join(", ")}`);
          }
          const anyReady = policy.profile_ids.some((id) => {
            try {
              return profileReadiness(db, id, { xaiVerified: xaiVerified() }).ready;
            } catch {
              return false;
            }
          });
          if (!anyReady) throw new Error("cannot enable automatic mode: none of the policy profiles is ready");
        }
        setSetting(db, body.key, body.value);
        return send(res, 200, { ok: true });
      }
      if (req.method === "GET" && url.pathname.startsWith("/queue/")) {
        const job = getJob(db, url.pathname.split("/")[2]);
        if (!job) return send(res, 404, { error: "job not found" });
        return send(res, 200, { job });
      }
      return send(res, 404, { error: "not found" });
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  });
  const stopRecovery = () => clearInterval(recoveryTimer);
  server.on("close", stopRecovery);
  return { server, db, secrets, stopRecovery };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = process.env.HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    console.error("refusing to bind a non-loopback host in private deployment");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 4101);
  const dataDir = process.env.AGENTV2_DATA_DIR ?? path.join(process.cwd(), "data");
  const { server } = createServer({ dataDir, port });
  server.listen(port, host, () => console.log(`agent-personal-v2 listening on http://${host}:${port} (private only)`));
}
