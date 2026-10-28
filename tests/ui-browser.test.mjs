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
  // Walk the cache recursively: binaries live three levels deep
  // (cache/chromium-1243/chrome-linux64/chrome on x64,
  // cache/chromium-1248/chrome-linux-arm64/chrome on Oracle ARM).
  const walk = (dir, depth) => {
    if (depth > 4 || !fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, entry.name);
      if (entry.isFile() && (entry.name === "chrome" || entry.name === "chrome-headless-shell")) candidates.push(p);
      else if (entry.isDirectory()) walk(p, depth + 1);
    }
  };
  walk(cache, 0);
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
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chromiumExecutable(), args: ["--no-sandbox"] });
  } catch (err) {
    // Never leave the test server listening on a failed launch, or the
    // test file process hangs forever waiting for the event loop.
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

test("browser: CV import preview and confirm, CV assignment, policies, consent, xAI key and readiness through the screen", async () => {
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
    // R4: assign the confirmed CV to the profile through the screen
    // (edit -> select CV -> save draft -> confirm draft).
    await app.page.click("#profiles-refresh");
    const card = app.page.locator(".profile-card").first();
    await card.getByRole("button", { name: "Editar" }).click();
    await app.page.waitForFunction(() => (document.querySelector(".profile-card")?.textContent ?? "").includes("Guardar borrador"));
    await card.locator("select").selectOption({ index: 1 });
    await card.getByRole("button", { name: "Guardar borrador" }).click();
    await app.page.waitForFunction(() => (document.querySelector(".profile-card")?.textContent ?? "").includes("Borrador guardado"));
    await card.getByRole("button", { name: "Confirmar borrador" }).click();
    await app.page.waitForFunction(() => (document.querySelector("#profiles-status")?.textContent ?? "").includes("Borrador confirmado"));
    // Policies: accept the required data-processing policy through the screen.
    await app.page.click("#policies-refresh");
    await app.page.waitForFunction(() => (document.querySelector("#policies-list")?.textContent ?? "").includes("Tratamiento de datos personales"));
    await app.page.getByRole("button", { name: "Aceptar Tratamiento de datos personales" }).click();
    await app.page.waitForFunction(() => (document.querySelector("#policies-list")?.textContent ?? "").includes("aceptada"));
    // Consent and xAI key through the screen. R3: a merely configured
    // (unverified) fake key must NOT yield readiness.
    await app.page.click("#consent-apply");
    await app.page.waitForFunction(() => (document.querySelector("#consent-status")?.textContent ?? "").includes("Consentimiento registrado"));
    await app.page.fill("#xai-key", "FAKE-BROWSER-XAI-KEY-ONLY");
    await app.page.click("#xai-save");
    await app.page.waitForFunction(() => (document.querySelector("#xai-status")?.textContent ?? "").includes("xAI: configurado, sin verificar"));
    const card2 = app.page.locator(".profile-card").first();
    await card2.getByRole("button", { name: "Comprobar preparación" }).click();
    await app.page.waitForFunction(() => (document.querySelector(".profile-card")?.textContent ?? "").includes("Falta: xAI verificado"));
  } finally {
    await stopApp(app);
  }
});

test("browser R2: load/save without changes preserves history, reorder moves ids, delete removes only one entry", async () => {
  const app = await startApp();
  try {
    const port = /** @type {import("node:net").AddressInfo} */ (app.server.address()).port;
    const base = `http://127.0.0.1:${port}`;
    // Seed a rich person through the API (setup only); every operation
    // under test below is performed through the screen.
    const rich = {
      full_name: "Synthetic Original",
      email: "original@example.test",
      links: ["https://example.test/professional-profile"],
      employment: [
        { id: "employment-alpha", employer: "Alpha Corp", title: "Analyst", start: "2019-03", end: "2022-01", links: ["https://example.test/alpha"], achievements: ["Synthetic achievement"] },
        { id: "employment-beta", employer: "Beta Corp", title: "Senior Analyst", start: "2022-02", current: true },
      ],
      education: [
        { id: "edu-alpha", institution: "Synthetic University", title: "BSc Synthetic", start: "2016", end: "2020", speciality: "Accounting", status: "completed" },
      ],
    };
    const created = await fetch(`${base}/api/person`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rich) });
    assert.equal(created.status, 201);
    const getPerson = async () => (await (await fetch(`${base}/api/person`)).json()).person.details;
    // Load, then save WITHOUT changing anything.
    await app.page.click("#person-load");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona actual"));
    assert.equal(await app.page.locator("#person-employment-list .entry-card").count(), 2);
    await app.page.click("#person-save");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona guardada"));
    let details = await getPerson();
    assert.deepEqual(details.employment, rich.employment, "an unchanged save must preserve every employment field and id");
    assert.deepEqual(details.education, rich.education, "an unchanged save must preserve education, speciality and date precision");
    assert.deepEqual(details.links, rich.links);
    // Reorder: move the first entry down, save, ids travel with entries.
    await app.page.locator("#person-employment-list .entry-card").first().getByRole("button", { name: "Bajar" }).click();
    await app.page.click("#person-save");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona guardada"));
    details = await getPerson();
    assert.deepEqual(details.employment.map((/** @type {any} */ e) => e.id), ["employment-beta", "employment-alpha"]);
    assert.equal(details.employment[0].employer, "Beta Corp");
    assert.equal(details.employment[0].current, true);
    assert.deepEqual(details.employment[1], rich.employment[0]);
    // Delete one entry: only it disappears, the rest is untouched.
    await app.page.locator("#person-employment-list .entry-card").first().getByRole("button", { name: "Eliminar" }).click();
    await app.page.click("#person-save");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona guardada"));
    details = await getPerson();
    assert.deepEqual(details.employment.map((/** @type {any} */ e) => e.id), ["employment-alpha"]);
    assert.deepEqual(details.employment[0], rich.employment[0]);
  } finally {
    await stopApp(app);
  }
});

test("browser G2 re-review 2: unchecking current, clearing links and editing authorisations saves explicitly", async () => {
  const app = await startApp();
  try {
    const port = /** @type {import("node:net").AddressInfo} */ (app.server.address()).port;
    const base = `http://127.0.0.1:${port}`;
    // Seed through the API (setup only); every edit under test is
    // performed through the screen, and the persisted state is
    // checked after a reload, through the screen and through the API.
    const rich = {
      full_name: "Synthetic Original",
      email: "original@example.test",
      links: ["https://example.test/professional-profile"],
      authorisations: [
        { id: "auth-1", country: "ES", status: "authorised", valid_until: "2030-12", sponsorship_required: true },
      ],
      employment: [
        { id: "employment-alpha", employer: "Alpha Corp", title: "Analyst", start: "2019-03", end: "2022-01" },
        { id: "employment-beta", employer: "Beta Corp", title: "Senior Analyst", start: "2022-02", current: true },
      ],
    };
    const created = await fetch(`${base}/api/person`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(rich) });
    assert.equal(created.status, 201);
    const getPerson = async () => (await (await fetch(`${base}/api/person`)).json()).person.details;
    await app.page.click("#person-load");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona actual"));
    assert.equal(await app.page.locator("#person-authorisations-list .auth-card").count(), 1);
    // (a) Uncheck "current" on the second job and enter an end date.
    const beta = app.page.locator("#person-employment-list .entry-card").nth(1);
    await beta.locator(".f-current").uncheck();
    await beta.locator(".f-end").fill("2024-06");
    // (b) Clear the personal links entirely.
    await app.page.fill("#person-links", "");
    // (c) Uncheck sponsorship and clear the validity on the authorisation.
    const auth = app.page.locator("#person-authorisations-list .auth-card").first();
    await auth.locator(".auth-sponsorship").uncheck();
    await auth.locator(".auth-valid-until").fill("");
    await app.page.click("#person-save");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona guardada"));
    // Reload and check the persisted state through the screen first.
    await app.page.click("#person-load");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona actual"));
    const betaAfter = app.page.locator("#person-employment-list .entry-card").nth(1);
    assert.equal(await betaAfter.locator(".f-current").isChecked(), false, "the unchecked current flag must stay unchecked after reload");
    assert.equal(await betaAfter.locator(".f-end").inputValue(), "2024-06");
    assert.equal(await app.page.locator("#person-links").inputValue(), "");
    const authAfter = app.page.locator("#person-authorisations-list .auth-card").first();
    assert.equal(await authAfter.locator(".auth-sponsorship").isChecked(), false);
    assert.equal(await authAfter.locator(".auth-valid-until").inputValue(), "");
    assert.equal(await authAfter.locator(".auth-country").inputValue(), "ES");
    // And through the API, the persisted record itself.
    const details = await getPerson();
    const betaDetails = details.employment.find((/** @type {any} */ e) => e.id === "employment-beta");
    assert.equal(betaDetails.current, false);
    assert.equal(betaDetails.end, "2024-06");
    assert.deepEqual(details.links, []);
    assert.equal(details.authorisations[0].valid_until, undefined);
    assert.equal(details.authorisations[0].sponsorship_required, false);
    assert.equal(details.authorisations[0].country, "ES");
    assert.equal(details.authorisations[0].status, "authorised");
  } finally {
    await stopApp(app);
  }
});
