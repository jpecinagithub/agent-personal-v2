// F1 server: private deployment only. Binds to 127.0.0.1 by default and
// refuses any non-loopback host. No login, no roles (constitution). The
// secrets endpoint lists names only; values never leave this process in
// a response.
import http from "node:http";
import path from "node:path";
import { openDatabase } from "../../packages/shared/db.mjs";
import { enqueue, claim, complete, fail, pauseJob, resumeJob, cancelJob, recover, getJob } from "../../packages/shared/queue.mjs";
import { appendEvent, listEvents } from "../../packages/shared/events.mjs";
import { SecretStore } from "../../packages/shared/secrets.mjs";
import { isAllowedControlOrigin } from "../../packages/shared/guard.mjs";

export function createServer({ dataDir, port = 0 }) {
  const db = openDatabase(path.join(dataDir, "agentv2.db"));
  recover(db);
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
          for (const e of events) res.write(`id: ${e.seq}\ndata: ${JSON.stringify({ type: e.type, payload: e.payload })}\n\n`);
          return; // keep the stream open for live events
        }
        return send(res, 200, { events });
      }
      if (req.method === "POST" && url.pathname === "/control/ping") {
        const ownOrigin = `http://127.0.0.1:${server.address().port}`;
        if (!isAllowedControlOrigin(req.headers.origin, ownOrigin)) return send(res, 403, { error: "foreign origin rejected" });
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/queue/enqueue") {
        const body = await readJson(req);
        const id = enqueue(db, body.kind ?? "job", body.payload ?? {});
        appendEvent(db, "job.enqueued", { jobId: id, kind: body.kind ?? "job" });
        return send(res, 201, { id });
      }
      if (req.method === "POST" && url.pathname === "/queue/claim") {
        const body = await readJson(req);
        const job = claim(db, body.workerId ?? "worker", body.leaseMs ?? 60000);
        return send(res, 200, { job });
      }
      if (req.method === "POST" && url.pathname === "/queue/complete") {
        const body = await readJson(req);
        complete(db, body.jobId, body.token, body.result ?? {});
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/queue/fail") {
        const body = await readJson(req);
        fail(db, body.jobId, body.token, body.result ?? {});
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/queue/pause") {
        const body = await readJson(req);
        pauseJob(db, body.jobId);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/queue/resume") {
        const body = await readJson(req);
        resumeJob(db, body.jobId);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/queue/cancel") {
        const body = await readJson(req);
        cancelJob(db, body.jobId);
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
  return { server, db, secrets };
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
