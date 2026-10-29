// F5 UI browser test: the "Respuestas y documentos" section renders,
// resolves a question, and generates + previews a document. Real
// Chromium; synthetic data only; preview only, nothing is submitted.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../apps/server/server.mjs";

function chromiumExecutable() {
  if (process.env.AGENTV2_CHROMIUM_PATH) return process.env.AGENTV2_CHROMIUM_PATH;
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === "chrome" || e.name === "headless_shell") found.push(p);
    }
  };
  walk(cache);
  if (found.length === 0) {
    throw new Error("no Chromium binary found under ~/.cache/ms-playwright (set AGENTV2_CHROMIUM_PATH or run `npx playwright install chromium`)");
  }
  found.sort();
  return found[0];
}

async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-f5browser-"));
  const { server } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromiumExecutable(), args: ["--no-sandbox"] });
  } catch (err) {
    server.close();
    throw err;
  }
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  return { server, browser, page, base: `http://127.0.0.1:${port}` };
}

test("F5 UI: answers section resolves and documents section generates + previews", async () => {
  const { server, browser, page, base } = await startApp();
  try {
    const person = await (await fetch(`${base}/api/person`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      full_name: "Test Person", email: "test.person@example.test",
      employment: [{ id: "job-1", employer: "Fixture Corp", title: "Accountant", start: "2020-01", end: "2024-06" }],
      education: [{ id: "edu-1", institution: "Fixture University", title: "BSc Test Studies", start: "2016", end: "2020" }],
    }) })).json();
    const profile = await (await fetch(`${base}/api/profiles`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      personId: person.id, name: "Finance", body: { desired_roles: ["Finance Manager"], skills: ["SAP", "Excel"] },
    }) })).json();
    await (await fetch(`${base}/api/facts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      personId: person.id, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user",
    }) })).json();

    await page.fill("#f5-person-id", person.id);
    await page.fill("#f5-question", "Are you authorized to work in Spain?");
    await page.click("#f5-resolve");
    await page.waitForFunction(() => (document.getElementById("f5-resolve-out")?.textContent ?? "").includes("declared"));
    const resolveOut = await page.textContent("#f5-resolve-out");
    assert.ok((resolveOut ?? "").includes("yes"), "the UI resolution shows the declared answer");

    await page.fill("#f5-doc-person", person.id);
    await page.fill("#f5-doc-profile", profile.id);
    await page.fill("#f5-doc-company", "Acme Corp");
    await page.fill("#f5-doc-role", "Finance Manager");
    await page.click("#f5-doc-generate");
    await page.waitForFunction(() => (document.getElementById("f5-doc-preview")?.textContent ?? "").includes("Fixture Corp"));
    const preview = await page.textContent("#f5-doc-preview");
    assert.ok((preview ?? "").includes("Test Person"));
    assert.ok((preview ?? "").includes("Accountant"));
    assert.ok(!(preview ?? "").includes("Harvard"), "the preview invents nothing");
    const docId = await page.inputValue("#f5-doc-id");
    assert.ok(docId, "generating fills the document id for download/attach");
  } finally {
    await browser.close();
    server.close();
  }
});
