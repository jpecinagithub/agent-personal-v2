// Pliego F3 INTEGRATION: the "Búsqueda" UI section through a REAL
// Chromium (playwright-core), no live network: definition create,
// connector panel + compile legend, catalog add, LinkedIn URL
// builder and extract error display. The server here runs with its
// default fetch, so the extract test uses a reserved .test URL whose
// fetch fails — the assertion is on the honest error display, not
// on a live page.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../apps/server/server.mjs";

function chromiumExecutable() {
  if (process.env.AGENTV2_CHROMIUM_PATH) return process.env.AGENTV2_CHROMIUM_PATH;
  const cache = path.join(os.homedir(), ".cache/ms-playwright");
  const candidates = [];
  const walk = (dir, depth) => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name);
      if (entry.isFile() && (entry.name === "chrome" || entry.name === "chrome-headless-shell")) candidates.push(p);
      else if (entry.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(cache, 0);
  const found = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!found) throw new Error("browser automation unavailable: no Chromium executable found in the Playwright cache (set AGENTV2_CHROMIUM_PATH)");
  return found;
}

async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-search-browser-"));
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
  return { server, browser, page };
}

async function stopApp(app) {
  await app.browser.close();
  app.server.close();
}

async function createPersonAndProfile(page) {
  await page.fill("#person-full-name", "Test Person");
  await page.fill("#person-email", "test.person@example.test");
  await page.click("#person-save");
  await page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona guardada"));
  await page.click("#nav-profiles");
  await page.click("#profile-create-open");
  await page.fill("#profile-name", "Finanzas");
  await page.click("#profile-create");
  await page.waitForFunction(() => (document.querySelector("#profiles-list")?.textContent ?? "").includes("Finanzas"));
}

test("browser: create a search definition through the Búsqueda form", async () => {
  const app = await startApp();
  try {
    await createPersonAndProfile(app.page);
    await app.page.click("#search-profiles-refresh");
    await app.page.waitForFunction(() => document.querySelectorAll("#search-def-profile option").length > 0);
    await app.page.fill("#search-def-name", "Búsqueda prueba");
    await app.page.fill("#search-def-titles", "Finance Manager");
    await app.page.fill("#search-def-countries", "ES");
    await app.page.click("#search-def-create");
    await app.page.waitForFunction(() => (document.querySelector("#search-def-status")?.textContent ?? "").includes("Búsqueda guardada"));
    await app.page.waitForFunction(() => (document.querySelector("#search-definitions-list")?.textContent ?? "").includes("Búsqueda prueba"));
    const list = await app.page.textContent("#search-definitions-list");
    assert.match(list ?? "", /Búsqueda prueba/);
  } finally {
    await stopApp(app);
  }
});

test("browser: connector panel, compile legend, catalog add, LinkedIn builder and extract error", async () => {
  const app = await startApp();
  try {
    await createPersonAndProfile(app.page);
    await app.page.click("#search-profiles-refresh");
    await app.page.waitForFunction(() => document.querySelectorAll("#search-def-profile option").length > 0);
    await app.page.fill("#search-def-name", "Búsqueda panel");
    await app.page.fill("#search-def-titles", "Finance Manager");
    await app.page.fill("#search-def-countries", "ES");
    await app.page.click("#search-def-create");
    await app.page.waitForFunction(() => (document.querySelector("#search-def-status")?.textContent ?? "").includes("Búsqueda guardada"));
    // Connector panel + compile legend (native / postprocessed / unsupported).
    await app.page.click("#search-connectors-refresh");
    await app.page.waitForFunction(() => (document.querySelector("#search-connectors-list")?.textContent ?? "").includes("Greenhouse"));
    const body = await app.page.textContent("body");
    assert.match(body ?? "", /nativo/);
    await app.page.click("#search-compile-refresh");
    await app.page.waitForFunction(() => (document.querySelector("#search-compile-out")?.textContent ?? "").includes("procesado después"));
    const compile = await app.page.textContent("#search-compile-out");
    assert.match(compile ?? "", /no disponible/);
    // Catalog add (adding is not verifying).
    await app.page.fill("#board-company", "Empresa Prueba");
    await app.page.selectOption("#board-ats", "greenhouse");
    await app.page.fill("#board-slug", "empresaprueba");
    await app.page.click("#board-add");
    await app.page.waitForFunction(() => (document.querySelector("#board-status")?.textContent ?? "").includes("Empresa añadida"));
    await app.page.waitForFunction(() => (document.querySelector("#boards-list")?.textContent ?? "").includes("Empresa Prueba"));
    // LinkedIn URL builder (assisted only).
    await app.page.fill("#linkedin-keywords", "Finance Manager");
    await app.page.fill("#linkedin-location", "Madrid");
    await app.page.click("#linkedin-build-url");
    await app.page.waitForFunction(() => (document.querySelector("#linkedin-url-out")?.textContent ?? "").includes("linkedin.com/jobs/search"));
    const linkedUrl = await app.page.textContent("#linkedin-url-out");
    assert.match(linkedUrl ?? "", /Finance/);
    // Extract error display: a reserved .test URL cannot be fetched,
    // and the page must show an honest failure, never a fabricated offer.
    await app.page.fill("#extract-url", "https://example.test/oferta-bloqueada");
    await app.page.click("#extract-run");
    await app.page.waitForFunction(() => /No disponible|Bloqueada|Error/.test(document.querySelector("#extract-out")?.textContent ?? ""));
    const extract = await app.page.textContent("#extract-out");
    assert.match(extract ?? "", /No disponible|Bloqueada|Error/);
  } finally {
    await stopApp(app);
  }
});
