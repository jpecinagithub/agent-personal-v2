// Pliego T-V2-022: the configuration UI is tested THROUGH A REAL
// BROWSER, not through direct API calls. These tests open the served
// page in headless Chromium (playwright-core) and perform the
// operations by clicking and typing in the page itself, asserting on
// what the page shows afterwards. If no Chromium executable is
// available, the test fails loudly with the exact cause instead of
// silently substituting API assertions.
// Chromium resolution: AGENTV2_CHROMIUM_PATH wins; otherwise the
// Playwright browser cache used by this environment.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../apps/server/server.mjs";

function chromiumExecutable() {
  if (process.env.AGENTV2_CHROMIUM_PATH) return process.env.AGENTV2_CHROMIUM_PATH;
  // Scan the Playwright cache instead of hardcoding one revision and one
  // architecture: the local machine has chromium-1243/chrome-linux64,
  // Oracle (aarch64) has chromium-1248/chrome-linux-arm64, and a
  // hardcoded path fails (or hangs the suite) on the other host.
  const cache = path.join(os.homedir(), ".cache/ms-playwright");
  const candidates = [];
  if (fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache).sort()) {
      for (const sub of fs.readdirSync(path.join(cache, dir))) {
        const p = path.join(cache, dir, sub);
        const base = path.basename(p);
        if (base === "chrome" || base === "chrome-headless-shell") candidates.push(p);
      }
    }
  }
  const found = candidates.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!found) {
    throw new Error(
      "browser automation unavailable: no Chromium executable found in the Playwright cache " +
      "(set AGENTV2_CHROMIUM_PATH or run `npx playwright install chromium`)",
    );
  }
  return found;
}

async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-browser-"));
  const { server } = createServer({ dataDir: dir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const browser = await chromium.launch({ executablePath: chromiumExecutable(), args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  return { server, browser, page };
}

async function stopApp(app) {
  await app.browser.close();
  app.server.close();
}

async function bodyText(page) {
  return (await page.textContent("body")) ?? "";
}

test("browser: create a person and a profile through the forms, no JSON, no IDs", async () => {
  const app = await startApp();
  try {
    await app.page.fill("#person-full-name", "Test Person");
    await app.page.fill("#person-email", "test.person@example.test");
    await app.page.fill("#person-languages", "English, C1");
    await app.page.click("#person-save");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona guardada"));
    assert.match(await bodyText(app.page), /Persona guardada: Test Person/);
    await app.page.fill("#profile-name", "Finanzas");
    await app.page.fill("#profile-focus", "Finance");
    await app.page.click("#profile-create");
    await app.page.waitForFunction(() => (document.querySelector("#profiles-list")?.textContent ?? "").includes("Finanzas"));
    const list = await app.page.textContent("#profiles-list");
    assert.match(list ?? "", /Finanzas/);
    assert.ok(!(list ?? "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/), "profile cards must not display internal UUIDs");
  } finally {
    await stopApp(app);
  }
});

test("browser: duplicate, archive and delete a profile through the screen", async () => {
  const app = await startApp();
  try {
    await app.page.fill("#person-full-name", "Test Person");
    await app.page.fill("#person-email", "test.person@example.test");
    await app.page.click("#person-save");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona guardada"));
    await app.page.fill("#profile-name", "Finanzas");
    await app.page.fill("#profile-focus", "Finance");
    await app.page.click("#profile-create");
    await app.page.waitForFunction(() => (document.querySelector("#profiles-list")?.textContent ?? "").includes("Finanzas"));
    const card = app.page.locator(".profile-card").first();
    await card.getByRole("button", { name: "Duplicar" }).click();
    await app.page.waitForFunction(() => document.querySelectorAll(".profile-card").length === 2);
    assert.match((await app.page.textContent("#profiles-list")) ?? "", /Finanzas \(copia\)/);
    // Archive the original, then delete it (deletion requires archived).
    await app.page.locator(".profile-card").first().getByRole("button", { name: "Archivar" }).click();
    await app.page.waitForFunction(() => (document.querySelector("#profiles-list")?.textContent ?? "").includes("(archivado)"));
    await app.page.locator(".profile-card").first().getByRole("button", { name: "Eliminar" }).click();
    await app.page.waitForFunction(() => document.querySelectorAll(".profile-card").length === 1);
    assert.match((await app.page.textContent("#profiles-list")) ?? "", /Finanzas \(copia\)/);
  } finally {
    await stopApp(app);
  }
});

test("browser: CV import preview and confirm, policies, consent, xAI key and readiness through the screen", async () => {
  const app = await startApp();
  try {
    await app.page.fill("#person-full-name", "Test Person");
    await app.page.fill("#person-email", "test.person@example.test");
    await app.page.click("#person-save");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona guardada"));
    await app.page.fill("#profile-name", "Finanzas");
    await app.page.fill("#profile-focus", "Finance");
    await app.page.click("#profile-create");
    await app.page.waitForFunction(() => (document.querySelector("#profiles-list")?.textContent ?? "").includes("Finanzas"));
    // CV: file input -> preview shows the known fixture text -> confirm.
    const fixture = new URL("./fixtures/sample.txt", import.meta.url).pathname;
    await app.page.setInputFiles("#cv-file", fixture);
    await app.page.click("#cv-preview");
    await app.page.waitForFunction(() => (document.querySelector("#cv-preview-out")?.textContent ?? "").includes("Test Person"));
    assert.match((await app.page.textContent("#cv-preview-out")) ?? "", /test\.person@example\.test/);
    await app.page.click("#cv-confirm");
    await app.page.waitForFunction(() => (document.querySelector("#cv-status")?.textContent ?? "").includes("CV validado"));
    // Policies: accept the required data-processing policy through the screen.
    await app.page.click("#policies-refresh");
    await app.page.waitForFunction(() => (document.querySelector("#policies-list")?.textContent ?? "").includes("Tratamiento de datos personales"));
    await app.page.getByRole("button", { name: "Aceptar Tratamiento de datos personales" }).click();
    await app.page.waitForFunction(() => (document.querySelector("#policies-list")?.textContent ?? "").includes("aceptada"));
    // Consent and xAI key through the screen.
    await app.page.click("#consent-apply");
    await app.page.waitForFunction(() => (document.querySelector("#consent-status")?.textContent ?? "").includes("Consentimiento registrado"));
    await app.page.fill("#xai-key", "FAKE-BROWSER-XAI-KEY-ONLY");
    await app.page.click("#xai-save");
    await app.page.waitForFunction(() => (document.querySelector("#xai-status")?.textContent ?? "").includes("xAI: configurado"));
    // Readiness through the screen: the profile card must now say ready.
    const card = app.page.locator(".profile-card").first();
    await card.getByRole("button", { name: "Comprobar preparación" }).click();
    await app.page.waitForFunction(() => (document.querySelector(".profile-card")?.textContent ?? "").includes("Perfil preparado"));
  } finally {
    await stopApp(app);
  }
});
