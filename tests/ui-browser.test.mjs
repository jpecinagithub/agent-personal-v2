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

test("browser G2 re-review 2: unchecking current and clearing links saves explicitly; form saves preserve authorisations", async () => {
  // WHY (user order 2026-10-28): the person form no longer edits work
  // authorisations, so the authorisation-card edit that used to live
  // in this test was removed. The seeded authorisation now serves a
  // different assertion: a form save must leave it byte-identical.
  // Backend edit-by-id stays covered in g2-rereview2/3/4 module tests.
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
    // (a) Uncheck "current" on the second job and enter an end date.
    const beta = app.page.locator("#person-employment-list .entry-card").nth(1);
    await beta.locator(".f-current").uncheck();
    await beta.locator(".f-end").fill("2024-06");
    // (b) Clear the personal links entirely.
    await app.page.fill("#person-links", "");
    await app.page.click("#person-save");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona guardada"));
    // Reload and check the persisted state through the screen first.
    await app.page.click("#person-load");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona actual"));
    const betaAfter = app.page.locator("#person-employment-list .entry-card").nth(1);
    assert.equal(await betaAfter.locator(".f-current").isChecked(), false, "the unchecked current flag must stay unchecked after reload");
    assert.equal(await betaAfter.locator(".f-end").inputValue(), "2024-06");
    assert.equal(await app.page.locator("#person-links").inputValue(), "");
    // And through the API, the persisted record itself.
    const details = await getPerson();
    const betaDetails = details.employment.find((/** @type {any} */ e) => e.id === "employment-beta");
    assert.equal(betaDetails.current, false);
    assert.equal(betaDetails.end, "2024-06");
    assert.deepEqual(details.links, []);
    // The form never sends authorisations now, so the seeded entry
    // must survive the form save exactly as stored.
    assert.deepEqual(details.authorisations, [
      { id: "auth-1", country: "ES", status: "authorised", valid_until: "2030-12", sponsorship_required: true },
    ]);
  } finally {
    await stopApp(app);
  }
});

test("browser G2 re-review 3: consecutive saves without reload refresh reference state", async () => {
  const app = await startApp();
  try {
    const port = /** @type {import("node:net").AddressInfo} */ (app.server.address()).port;
    const base = `http://127.0.0.1:${port}`;
    // Seed through the API (setup only); every edit under test is
    // performed through the screen, with saves between changes and
    // no reload in between. The bug: reference flags described the
    // state at load, so the second save omitted empties/false values
    // based on pre-first-save state and the backend kept them.
    const seed = {
      full_name: "Synthetic Original",
      email: "original@example.test",
      employment: [
        { id: "job-1", employer: "Alpha Corp", title: "Analyst", start: "2020-01", current: false },
      ],
      authorisations: [
        { id: "auth-1", country: "ES", status: "authorised", valid_until: "2030-12", sponsorship_required: false },
      ],
    };
    const created = await fetch(`${base}/api/person`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(seed) });
    assert.equal(created.status, 201);
    const getPerson = async () => (await (await fetch(`${base}/api/person`)).json()).person.details;
    const savePerson = async () => {
      const [resp] = await Promise.all([
        app.page.waitForResponse((r) => r.url().endsWith("/api/person") && r.request().method() === "POST"),
        app.page.click("#person-save"),
      ]);
      assert.equal(resp.status(), 201);
      await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona guardada"));
    };
    await app.page.click("#person-load");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona actual"));
    // First save: add values to fields that were absent/false.
    await app.page.fill("#person-links", "https://example.test/professional-profile");
    await app.page.fill("#person-skills", "accounting");
    await app.page.fill("#person-salary-currency", "EUR");
    await app.page.fill("#person-salary-min", "40000");
    await app.page.fill("#person-salary-max", "60000");
    await app.page.fill("#person-salary-period", "year");
    const job = app.page.locator("#person-employment-list .entry-card").first();
    await job.locator(".f-achievements").fill("Shipped X");
    await job.locator(".f-links").fill("https://example.test/job");
    await job.locator(".f-current").check();
    await savePerson();
    let details = await getPerson();
    assert.deepEqual(details.links, ["https://example.test/professional-profile"]);
    assert.deepEqual(details.skills, ["accounting"]);
    assert.deepEqual(details.salary_expectations, { currency: "EUR", min: 40000, max: 60000, period: "year" });
    assert.deepEqual(details.employment[0].achievements, ["Shipped X"]);
    assert.deepEqual(details.employment[0].links, ["https://example.test/job"]);
    assert.equal(details.employment[0].current, true);
    // Second save WITHOUT reloading: clear everything just added,
    // uncheck both boxes, add an end date.
    await app.page.fill("#person-links", "");
    await app.page.fill("#person-skills", "");
    await app.page.fill("#person-salary-currency", "");
    await app.page.fill("#person-salary-min", "");
    await app.page.fill("#person-salary-max", "");
    await app.page.fill("#person-salary-period", "");
    const job2 = app.page.locator("#person-employment-list .entry-card").first();
    await job2.locator(".f-achievements").fill("");
    await job2.locator(".f-links").fill("");
    await job2.locator(".f-current").uncheck();
    await job2.locator(".f-end").fill("2024-06");
    await savePerson();
    // Reload and check the persisted state through the screen first.
    await app.page.click("#person-load");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona actual"));
    assert.equal(await app.page.locator("#person-links").inputValue(), "");
    assert.equal(await app.page.locator("#person-skills").inputValue(), "");
    assert.equal(await app.page.locator("#person-salary-currency").inputValue(), "");
    const jobAfter = app.page.locator("#person-employment-list .entry-card").first();
    assert.equal(await jobAfter.locator(".f-achievements").inputValue(), "");
    assert.equal(await jobAfter.locator(".f-links").inputValue(), "");
    assert.equal(await jobAfter.locator(".f-current").isChecked(), false);
    assert.equal(await jobAfter.locator(".f-end").inputValue(), "2024-06");
    // And through the API, the persisted record itself.
    details = await getPerson();
    assert.deepEqual(details.links, []);
    assert.deepEqual(details.skills, []);
    assert.deepEqual(details.salary_expectations, {});
    assert.deepEqual(details.employment[0].achievements, []);
    assert.deepEqual(details.employment[0].links, []);
    assert.equal(details.employment[0].current, false);
    assert.equal(details.employment[0].end, "2024-06");
    // WHY (user order 2026-10-28): the form no longer edits
    // authorisations, so the seeded entry must survive both
    // consecutive form saves exactly as stored.
    assert.deepEqual(details.authorisations, [
      { id: "auth-1", country: "ES", status: "authorised", valid_until: "2030-12", sponsorship_required: false },
    ]);
  } finally {
    await stopApp(app);
  }
});

test("browser: person form no longer shows authorisations, and a form save preserves them", async () => {
  // WHY (user order 2026-10-28): the person form no longer shows or
  // edits work authorisations. The card-driven G2 re-review 3/4
  // browser tests (legacy id adoption, extra-field preservation,
  // card delete, card edit, same-country distinction) were removed
  // because the cards they drove no longer exist. Backend edit,
  // delete-by-id and persisted-id behaviour stays covered by the
  // g2-rereview3/4 module tests, and form-save preservation by
  // form-authorisation-preservation.test.mjs. This test guards the new
  // contract through the real screen: no authorisations UI at all,
  // and a form save leaves stored authorisations byte-identical.
  const app = await startApp();
  try {
    const port = /** @type {import("node:net").AddressInfo} */ (app.server.address()).port;
    const base = `http://127.0.0.1:${port}`;
    const seed = {
      full_name: "Synthetic Original",
      email: "original@example.test",
      authorisations: [
        { country: "ES", status: "authorised", valid_until: "2030-12", sponsorship_required: false, valid_from: "2025-01", source_note: "Synthetic user declaration" },
        { country: "FR", status: "authorised", valid_until: "2029-06", sponsorship_required: true },
      ],
    };
    const created = await fetch(`${base}/api/person`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(seed) });
    assert.equal(created.status, 201);
    const getPerson = async () => (await (await fetch(`${base}/api/person`)).json()).person.details;
    const before = (await getPerson()).authorisations;
    assert.equal(before.length, 2, "seeded authorisations stored (ids normalised on read)");
    await app.page.click("#person-load");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona actual"));
    // The rest of the form still renders, but no authorisations UI.
    assert.equal(await app.page.locator("#person-full-name").inputValue(), "Synthetic Original");
    assert.equal(await app.page.locator("#person-authorisations-list").count(), 0, "no authorisations list in the form");
    assert.equal(await app.page.getByRole("button", { name: "Añadir autorización" }).count(), 0, "no add-authorisation button");
    assert.ok(!(await bodyText(app.page)).includes("Autorizaciones de trabajo"), "no authorisations heading in the form");
    // Save through the form (changing an unrelated field) and check
    // the stored authorisations survived exactly.
    await app.page.fill("#person-skills", "accounting");
    await app.page.click("#person-save");
    await app.page.waitForFunction(() => (document.querySelector("#person-status")?.textContent ?? "").includes("Persona guardada"));
    const after = (await getPerson()).authorisations;
    assert.deepEqual(after, before, "form save preserves stored authorisations byte-identical, ids and extra fields intact");
  } finally {
    await stopApp(app);
  }
});
