// T-V2-013: secret store (0600, names only), host allowlist, origin check.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SecretStore } from "../packages/shared/secrets.mjs";
import { assertFetchHost, isAllowedControlOrigin } from "../packages/shared/guard.mjs";
import { createServer } from "../apps/server/server.mjs";

test("secret store encrypts at rest: file bytes never contain the value, both files 0600", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-sec-"));
  const file = path.join(dir, "secrets.json");
  const keyFile = path.join(dir, "secrets.key");
  const store = new SecretStore(file);
  store.set("xai_api_key", "FAKE-TEST-KEY-ONLY");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(file, "utf8").includes("FAKE-TEST-KEY-ONLY"), "plaintext value must not appear in the data file");
  assert.ok(!fs.readFileSync(keyFile, "utf8").includes("FAKE-TEST-KEY-ONLY"), "value must not appear in the key file");
  assert.deepEqual(store.list(), ["xai_api_key"]);
  assert.equal(store.get("xai_api_key"), "FAKE-TEST-KEY-ONLY", "values must still round-trip through decryption");
  assert.throws(() => store.set("bad-name!", "x"), /invalid secret name/);
  assert.throws(() => store.set("ok_name", ""), /non-empty/);
  // A fresh store object over the same files decrypts the same values.
  const reopened = new SecretStore(file);
  assert.equal(reopened.get("xai_api_key"), "FAKE-TEST-KEY-ONLY");
});

test("legacy plaintext store migrates to encrypted form on load", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-sec-mig-"));
  const file = path.join(dir, "secrets.json");
  fs.writeFileSync(file, JSON.stringify({ legacy_key: "FAKE-LEGACY-VALUE" }), { mode: 0o600 });
  const store = new SecretStore(file);
  assert.equal(store.get("legacy_key"), "FAKE-LEGACY-VALUE");
  assert.ok(!fs.readFileSync(file, "utf8").includes("FAKE-LEGACY-VALUE"), "the file must be encrypted after migration");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "secrets.key")).mode & 0o777, 0o600);
});

test("server /secrets endpoint never returns a value", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-sec2-"));
  const { server, secrets } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
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

test("foreign Origin is rejected on every command route and changes nothing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-sec4-"));
  const { server } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const own = `http://127.0.0.1:${port}`;
  const foreign = "https://evil.example.com";
  const post = (p, body, origin) =>
    fetch(`${own}${p}`, { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body ?? {}) });
  try {
    // Foreign enqueue: 403, and no job and no event is created.
    const badEnqueue = await post("/queue/enqueue", { kind: "search" }, foreign);
    assert.equal(badEnqueue.status, 403);
    const eventsBefore = await (await fetch(`${own}/events`)).json();
    assert.equal(eventsBefore.events.length, 0, "a rejected enqueue must not append an event");
    // Own-origin enqueue works, then claim it.
    const goodEnqueue = await post("/queue/enqueue", { kind: "search" }, own);
    assert.equal(goodEnqueue.status, 201);
    const { id } = await goodEnqueue.json();
    const claimedRes = await post("/queue/claim", { workerId: "w" }, own);
    const claimed = await claimedRes.json();
    assert.equal(claimed.job.id, id);
    // Foreign complete: 403, job stays claimed with the same token.
    const badComplete = await post("/queue/complete", { jobId: id, token: claimed.job.lease_token }, foreign);
    assert.equal(badComplete.status, 403);
    const jobAfter = await (await fetch(`${own}/queue/${id}`)).json();
    assert.equal(jobAfter.job.status, "claimed");
    assert.equal(jobAfter.job.lease_token, claimed.job.lease_token);
    // Foreign pause/cancel/claim also rejected; own-origin complete still works.
    assert.equal((await post("/queue/pause", { jobId: id }, foreign)).status, 403);
    assert.equal((await post("/queue/cancel", { jobId: id }, foreign)).status, 403);
    assert.equal((await post("/queue/claim", { workerId: "intruder" }, foreign)).status, 403);
    const okComplete = await post("/queue/complete", { jobId: id, token: claimed.job.lease_token }, own);
    assert.equal(okComplete.status, 200);
  } finally {
    server.close();
  }
});

test("control channel rejects a foreign Origin", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-sec3-"));
  const { server } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
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
