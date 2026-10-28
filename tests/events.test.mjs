// T-V2-012: sequenced events, sanitizer, SSE replay without duplicates.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { appendEvent, listEvents, sanitize } from "../packages/shared/events.mjs";
import { createServer } from "../apps/server/server.mjs";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-ev-"));
}

test("sanitizer strips secret-like keys recursively", () => {
  const out = sanitize({ apiKey: "FAKE-KEY-123", nested: { password: "FAKE-PASS", ok: 1 }, items: [{ authToken: "x" }] });
  assert.equal(out.apiKey, "[redacted]");
  assert.equal(out.nested.password, "[redacted]");
  assert.equal(out.nested.ok, 1);
  assert.equal(out.items[0].authToken, "[redacted]");
  assert.ok(!JSON.stringify(out).includes("FAKE-KEY-123"));
});

test("events are sequenced and listEvents replays from a seq", () => {
  const db = openDatabase(path.join(tmpDir(), "agentv2.db"));
  const s1 = appendEvent(db, "a", { x: 1, apiKey: "FAKE" });
  const s2 = appendEvent(db, "b", { x: 2 });
  const s3 = appendEvent(db, "c", { x: 3 });
  assert.deepEqual([s1, s2, s3], [1, 2, 3]);
  const replay = listEvents(db, 1);
  assert.deepEqual(replay.map((e) => e.seq), [2, 3]);
  assert.equal(replay[0].payload.x, 2);
  assert.equal(listEvents(db, 1)[0].payload.x, 2);
  const first = db.prepare("SELECT payload_json FROM events WHERE seq = 1").get();
  assert.ok(!first.payload_json.includes("FAKE"), "secret must never be stored");
});

test("SSE replay after disconnect returns only unseen events, no duplicates", async () => {
  const { server, db } = createServer({ dataDir: tmpDir() });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    appendEvent(db, "job.enqueued", { jobId: "synthetic-1" });
    appendEvent(db, "job.enqueued", { jobId: "synthetic-2" });
    appendEvent(db, "job.enqueued", { jobId: "synthetic-3" });
    // First connection: read the replay, then disconnect (client closes).
    const first = await readSse(`http://127.0.0.1:${port}/events?since=0`, 2);
    assert.deepEqual(first, [1, 2]);
    // Reconnect from Last-Event-ID 2: only event 3, never 1 or 2 again.
    const second = await readSse(`http://127.0.0.1:${port}/events?since=2`, 1);
    assert.deepEqual(second, [3]);
  } finally {
    server.close();
  }
});

function readSse(url, wantCount) {
  return new Promise((resolve, reject) => {
    const ids = [];
    const req = fetch(url, { headers: { Accept: "text/event-stream" } });
    req.then(async (res) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const timer = setTimeout(() => reject(new Error("SSE timeout")), 5000);
      while (ids.length < wantCount) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const m = block.match(/^id: (\d+)/m);
          if (m) ids.push(Number(m[1]));
          if (ids.length >= wantCount) break;
        }
      }
      clearTimeout(timer);
      reader.cancel();
      resolve(ids);
    }).catch(reject);
  });
}
