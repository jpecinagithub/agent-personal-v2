// F5 server routes (T-V2-041..048): HTTP-level tests on a fresh
// disposable DB with synthetic data only. Generation and preview
// only: no route here creates an attempt or submits anything.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../apps/server/server.mjs";

async function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-f5server-"));
  const { server } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function post(base, pathName, body) {
  const r = await fetch(`${base}${pathName}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

async function get(base, pathName) {
  const r = await fetch(`${base}${pathName}`);
  return { status: r.status, json: await r.json().catch(() => ({})) };
}

test("F5 server: semantic resolve + evaluate, document generate/preview/download/attach, versions", async () => {
  const { server, base } = await startServer();
  try {
    const person = await post(base, "/api/person", {
      full_name: "Test Person", email: "test.person@example.test",
      employment: [{ id: "job-1", employer: "Fixture Corp", title: "Accountant", start: "2020-01", end: "2024-06" }],
      education: [{ id: "edu-1", institution: "Fixture University", title: "BSc Test Studies", start: "2016", end: "2020" }],
    });
    assert.equal(person.status, 201);
    const personId = person.json.id;
    const profile = await post(base, "/api/profiles", {
      personId, name: "Finance",
      body: { desired_roles: ["Finance Manager"], skills: ["SAP", "Excel"] },
    });
    assert.equal(profile.status, 201);
    const profileId = profile.json.id;
    const fact = await post(base, "/api/facts", { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
    assert.equal(fact.status, 201);

    const resolved = await post(base, "/api/semantic/resolve", { personId, text: "Are you authorized to work in Spain?" });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.json.answer.kind, "declared");
    assert.equal(resolved.json.answer.value, "yes");
    const aliases = await get(base, `/api/semantic/aliases?personId=${personId}`);
    assert.ok(aliases.json.aliases.length >= 1, "a verified resolution stores its alias");

    const ev = await post(base, "/api/semantic/evaluate", {
      personId,
      cases: [
        { text: "Are you authorized to work in Spain?" },
        { text: "Are you authorised to work in ES?" },
        { text: "Are you not authorized to work in Spain?" },
      ],
    });
    assert.equal(ev.json.evaluation.contamination, 0);
    assert.equal(ev.json.evaluation.humanQuestionsCreated, 0);

    const doc = await post(base, "/api/documents", { personId, profileId, kind: "resume", company: "Acme Corp", role: "Finance Manager" });
    assert.equal(doc.status, 201);
    assert.equal(doc.json.version, 1);
    assert.equal(doc.json.content.language, "en");
    const documentId = doc.json.documentId;

    const pdf = await fetch(`${base}/api/documents/${documentId}/download?format=pdf`);
    assert.equal(pdf.status, 200);
    assert.ok((pdf.headers.get("content-type") || "").includes("application/pdf"));
    const pdfBytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(pdfBytes.subarray(0, 5).toString("latin1"), "%PDF-");
    const docx = await fetch(`${base}/api/documents/${documentId}/download?format=docx`);
    assert.equal(docx.status, 200);
    assert.equal(Buffer.from(await docx.arrayBuffer()).subarray(0, 2).toString("latin1"), "PK");

    const attached = await post(base, `/api/documents/${documentId}/attachments`, { format: "pdf", role: "resume", portalRequirements: { allowedFormats: ["pdf"] } });
    assert.equal(attached.status, 201);
    assert.equal(attached.json.attachment.status, "prepared");
    assert.equal(attached.json.attachment.portalReceipt, null);
    const badFormat = await post(base, `/api/documents/${documentId}/attachments`, { format: "pdf", role: "resume", portalRequirements: { allowedFormats: ["docx"] } });
    assert.equal(badFormat.status, 400, "an impossible portal format fails explainably, never silently");

    const edited = await post(base, `/api/documents/${documentId}/edit`, { content: { ...doc.json.content, sections: [...doc.json.content.sections, { heading: "Extra", lines: [{ text: "SAP", refs: [{ kind: "profile", field: "skills", value: ["SAP", "Excel"] }] }] }] } });
    assert.equal(edited.json.edited.version, 2);
    assert.equal(edited.json.edited.status, "validated");
    const versions = await get(base, `/api/documents/${documentId}/versions`);
    assert.equal(versions.json.versions.length, 2);
    assert.equal(versions.json.versions[0].version, 1);

    const docs = await get(base, `/api/documents?personId=${personId}`);
    assert.ok(docs.json.documents.some((d) => d.id === documentId));
    // No attempt, queue job or final action is created by any F5 route.
    const attempts = await get(base, `/api/attempts/${documentId}`);
    assert.equal(attempts.status, 404);
  } finally {
    server.close();
  }
});
