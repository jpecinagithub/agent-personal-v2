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
  // Mocked xAI provider for the verify route: a valid models list
  // containing the default model. No real key, no real call, no spend.
  const verifyFetchFn = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: "grok-4.20-non-reasoning" }] }),
    text: async () => "{}",
  });
  const { server, secrets } = createServer({ dataDir: dir, verifyFetchFn });
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
    for (const section of ["Persona", "Perfiles", "Currículum (CV)", "Hechos declarados", "Mapeos de campos", "Preguntas y respuestas", "Políticas y consentimientos", "Configuración de xAI", "Modo automático"]) {
      assert.ok(html.includes(section), `UI is missing section: ${section}`);
    }
    // No JSON editing and no internal IDs to copy: the form uses named
    // fields, and the page must not print raw profile/person UUIDs.
    assert.ok(html.includes('id="person-full-name"'), "person form must have named fields");
    assert.ok(!html.includes("person-json"), "the UI must not ask the user to write JSON for the person");
    assert.ok(!html.includes("FAKE-UI-SECRET-ONLY"), "secret value leaked into the UI page");
    const names = await (await fetch(`${base}/secrets`)).json();
    assert.deepEqual(names.names, ["xai_api_key"]);
    assert.ok(!JSON.stringify(names).includes("FAKE-UI-SECRET-ONLY"));
  } finally {
    server.close();
  }
});

test("configuration changes through the API take effect without restart, and foreign origins cannot command the UI API", async () => {
  const { server, secrets, base } = await startServer();
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
    // Readiness is NOT met yet: CV, policy, consent and xAI are missing.
    const profileId = (await profileRes.json()).id;
    const notReady = await (await fetch(`${base}/api/profiles/${profileId}/readiness`)).json();
    assert.equal(notReady.ready, false);
    for (const key of ["cv_validated", "policy", "consent", "xai"]) {
      assert.ok(notReady.missing.includes(key), `readiness must name ${key}`);
    }
    // Complete the RF-V2-020 requirements through the API: confirmed CV
    // ASSIGNED TO THIS PROFILE (R4), accepted required policy,
    // apply-on-behalf consent, and a VERIFIED xAI key (R3: a merely
    // configured key must not suffice).
    const fs = await import("node:fs");
    const txt = fs.readFileSync(new URL("./fixtures/sample.txt", import.meta.url).pathname).toString("base64");
    const cvRes = await post(base, "/api/cv", { personId, filename: "sample.txt", contentBase64: txt });
    assert.equal(cvRes.status, 201);
    const cvId = (await cvRes.json()).id;
    const confirmRes = await post(base, `/api/cv/${cvId}/confirm`, {});
    assert.equal(confirmRes.status, 200);
    const draftRes = await post(base, `/api/profiles/${profileId}/drafts`, {});
    assert.equal(draftRes.status, 201);
    const draftId = (await draftRes.json()).id;
    const draftPut = await fetch(`${base}/api/drafts/${draftId}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: { focus: "Finance", factRefs: [{ concept: "work_authorisation", scope: "ES" }], cv_import_id: cvId } }) });
    assert.equal(draftPut.status, 200);
    const draftConfirm = await post(base, `/api/drafts/${draftId}/confirm`, {});
    assert.equal(draftConfirm.status, 200);
    const policyRes = await post(base, "/api/policies/data_processing/accept", { personId });
    assert.equal(policyRes.status, 200);
    const consentRes = await post(base, "/api/consents", { personId, key: "apply_on_behalf" });
    assert.equal(consentRes.status, 200);
    secrets.set("xai_api_key", "FAKE-UI-XAI-KEY-ONLY");
    const unverified = await (await fetch(`${base}/api/profiles/${profileId}/readiness`)).json();
    assert.equal(unverified.ready, false, "a merely configured (unverified) key must not yield readiness");
    assert.deepEqual(unverified.missing, ["xai"]);
    const verifyRes = await post(base, "/api/xai-verify", {});
    assert.equal(verifyRes.status, 200);
    assert.equal((await verifyRes.json()).ok, true);
    const readiness = await (await fetch(`${base}/api/profiles/${profileId}/readiness`)).json();
    assert.equal(readiness.ready, true, `readiness must pass once all requirements are met, missing: ${readiness.missing.join(", ")}`);
    // Automatic mode is off initially and can only be enabled now.
    const settingsBefore = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(settingsBefore.auto_mode, "off");
    const resolve = await post(base, "/api/resolve", { personId, questions: [{ concept: "work_authorisation", scope: "ES" }] });
    assert.equal((await resolve.json()).answers[0].kind, "declared");
    // A foreign web page cannot use the UI API to change configuration.
    const factsBefore = await (await fetch(`${base}/api/facts?personId=${personId}`)).json();
    const foreign = await post(base, "/api/facts", { personId, concept: "evil", value: "x", provenance: "user" }, "https://evil.example.test");
    assert.equal(foreign.status, 403);
    const factsAfter = await (await fetch(`${base}/api/facts?personId=${personId}`)).json();
    assert.equal(factsAfter.facts.length, factsBefore.facts.length, "foreign command must change nothing");
    assert.ok(!factsAfter.facts.some((/** @type {any} */ f) => f.concept === "evil"), "foreign command must not add a fact");
  } finally {
    server.close();
  }
});
