// T-V2-013: secret store (0600, names only), host allowlist, origin check.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretStore } from "../packages/shared/secrets.mjs";
import { assertFetchHost, isAllowedControlOrigin } from "../packages/shared/guard.mjs";
import { createServer } from "../apps/server/server.mjs";

test("secret store keeps 0600 mode and lists names only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-sec-"));
  const file = path.join(dir, "secrets.json");
  const store = new SecretStore(file);
  store.set("xai_api_key", "FAKE-TEST-KEY-ONLY");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(store.list(), ["xai_api_key"]);
  assert.equal(store.get("xai_api_key"), "FAKE-TEST-KEY-ONLY");
  assert.throws(() => store.set("bad-name!", "x"), /invalid secret name/);
  assert.throws(() => store.set("ok_name", ""), /non-empty/);
});

test("server /secrets endpoint never returns a value", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-sec2-"));
  const { server, secrets } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    secrets.set("xai_api_key", "FAKE-TEST-KEY-ONLY");
    const res = await fetch(`http://127.0.0.1:${port}/secrets`);
    const body = await res.text();
    assert.ok(body.includes("xai_api_key"));
    assert.ok(!body.includes("FAKE-TEST-KEY-ONLY"), "value leaked through API");
  } finally {
    server.close();
  }
});

test("fetch guard allows only the declared hosts over https", () => {
  for (const h of ["boards-api.greenhouse.io", "api.lever.co", "api.ashbyhq.com", "api.smartrecruiters.com", "api.x.ai"]) {
    assert.equal(assertFetchHost(`https://${h}/v1/x`).hostname, h);
  }
  assert.throws(() => assertFetchHost("https://evil.example.com/x"), /host not allowed/);
  assert.throws(() => assertFetchHost("https://api.x.ai.evil.example.com/x"), /host not allowed/);
  assert.throws(() => assertFetchHost("http://api.x.ai/v1"), /only https/);
});

test("control channel rejects a foreign Origin", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-sec3-"));
  const { server } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const own = `http://127.0.0.1:${port}`;
  try {
    assert.equal(isAllowedControlOrigin(undefined, own), true);
    assert.equal(isAllowedControlOrigin(own, own), true);
    assert.equal(isAllowedControlOrigin("https://evil.example.com", own), false);
    const res = await fetch(`${own}/control/ping`, { method: "POST", headers: { Origin: "https://evil.example.com" } });
    assert.equal(res.status, 403);
    const ok = await fetch(`${own}/control/ping`, { method: "POST", headers: { Origin: own } });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
});
