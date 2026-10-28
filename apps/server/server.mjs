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
import { createProfileFull, listProfiles, getProfileFull, archiveProfile, unarchiveProfile, deleteProfile, profileReadiness, createAttempt, getAttempt } from "../../packages/shared/profiles.mjs";
import { createDraft, getDraft, listDrafts, updateDraft, discardDraft, confirmDraft } from "../../packages/shared/drafts.mjs";
import { declareFact, listFacts } from "../../packages/shared/facts.mjs";
import { resolveScreening, answerPendingQuestion, listPendingQuestions } from "../../packages/shared/resolve.mjs";
import { defineMapping, getMapping, listMappings } from "../../packages/shared/mappings.mjs";

export function createServer({ dataDir, port = 0, recoverIntervalMs = 30000 }) {
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
        return send(res, 200, profileReadiness(db, profileId));
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
        const id = createAttempt(db, body.personId, body.profileId, body.offerId);
        return send(res, 201, { id, attempt: getAttempt(db, id) });
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
