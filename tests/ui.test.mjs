// T-V2-022: Configuration from the UI. The page is served by the
// existing server with no build step; changes take effect through the
// API without redeploy or restart; secret values are never exposed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../apps/server/server.mjs";

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-ui-"));
  const { server, secrets } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  return { server, secrets, base: `http://127.0.0.1:${port}` };
}

async function post(base, path, body, origin) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
}

test("the UI page is served, covers all configuration areas, and never exposes secret values", async () => {
  const { server, secrets, base } = await startServer();
  try {
    secrets.set("xai_api_key", "FAKE-UI-SECRET-ONLY");
    const html = await (await fetch(`${base}/`)).text();
    for (const section of ["Persona", "Perfiles", "Hechos declarados", "Mapeos de campos", "Preguntas y respuestas", "Borradores"]) {
      assert.ok(html.includes(section), `UI is missing section: ${section}`);
    }
    assert.ok(!html.includes("FAKE-UI-SECRET-ONLY"), "secret value leaked into the UI page");
    const names = await (await fetch(`${base}/secrets`)).json();
    assert.deepEqual(names.names, ["xai_api_key"]);
    assert.ok(!JSON.stringify(names).includes("FAKE-UI-SECRET-ONLY"));
  } finally {
    server.close();
  }
});

test("configuration changes through the API take effect without restart, and foreign origins cannot command the UI API", async () => {
  const { server, base } = await startServer();
  try {
    const personRes = await post(base, "/api/person", {
      full_name: "Test Person", email: "test.person@example.test",
      languages: [{ language: "English", level: "C1" }],
      authorisations: [{ country: "ES", status: "authorised" }],
    });
    assert.equal(personRes.status, 201);
    const personId = (await personRes.json()).id;
    const profileRes = await post(base, "/api/profiles", { personId, name: "Finance", body: { focus: "Finance", factRefs: [{ concept: "work_authorisation", scope: "ES" }] } });
    assert.equal(profileRes.status, 201);
    const factRes = await post(base, "/api/facts", { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
    assert.equal(factRes.status, 201);
    // No restart happened between the writes and these reads.
    const facts = await (await fetch(`${base}/api/facts?personId=${personId}`)).json();
    assert.equal(facts.facts.length, 1);
    const readiness = await (await fetch(`${base}/api/profiles/${(await profileRes.json()).id}/readiness`)).json();
    assert.equal(readiness.ready, true);
    const resolve = await post(base, "/api/resolve", { personId, questions: [{ concept: "work_authorisation", scope: "ES" }] });
    assert.equal((await resolve.json()).answers[0].kind, "declared");
    // A foreign web page cannot use the UI API to change configuration.
    const foreign = await post(base, "/api/facts", { personId, concept: "evil", value: "x", provenance: "user" }, "https://evil.example.test");
    assert.equal(foreign.status, 403);
    const factsAfter = await (await fetch(`${base}/api/facts?personId=${personId}`)).json();
    assert.equal(factsAfter.facts.length, 1, "foreign command must change nothing");
  } finally {
    server.close();
  }
});
