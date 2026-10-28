// Reviewer adversarial tests for the G2 regression (CODEX review, 2026-10-28):
// the three defects reproduced on the exact ebc8b93 copy. Test bodies are
// the reviewer's, unchanged. ONLY the Chromium resolution is adapted: the
// original hardcoded the reviewer's Windows Chrome path, which cannot run
// anywhere else, so resolution is now AGENTV2_CHROMIUM_PATH first, then
// that Windows path when it exists, then the Playwright cache scan used
// by tests/ui-browser.test.mjs (Linux VM chromium-1243, Oracle
// chromium-1248). The tests themselves assert the same behaviours.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../apps/server/server.mjs";

const WINDOWS_CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";

function chromiumExecutable() {
  if (process.env.AGENTV2_CHROMIUM_PATH) return process.env.AGENTV2_CHROMIUM_PATH;
  if (fs.existsSync(WINDOWS_CHROME)) return WINDOWS_CHROME;
  const cache = path.join(os.homedir(), ".cache/ms-playwright");
  const candidates = [];
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
      "browser automation unavailable: no Chromium executable found " +
        "(set AGENTV2_CHROMIUM_PATH or run `npx playwright install chromium`)",
    );
  }
  return found;
}

async function startApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-reviewer-g2-"));
  const { server } = createServer({ dataDir });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const base = `http://127.0.0.1:${port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chromiumExecutable(), args: ["--no-sandbox"] });
  } catch (err) {
    server.close();
    throw err;
  }
  const page = await browser.newPage();
  await page.goto(base);
  return { server, browser, page, base };
}

async function stopApp(app) {
  await app.browser.close();
  await new Promise((resolve) => app.server.close(resolve));
}

async function post(base, url, body) {
  return fetch(base + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("reviewer: a non-binary authorisation state is never promoted to authorised by a UI save", async () => {
  const app = await startApp();
  try {
    await post(app.base, "/api/person", {
      full_name: "Synthetic Person",
      email: "synthetic@example.test",
      authorisations: [{ country: "ES", status: "pending", sponsorship_required: false, source_note: "synthetic" }],
    });
    await app.page.click("#person-load");
    await app.page.waitForFunction(() => document.querySelectorAll("#person-authorisations-list .auth-card").length === 1);
    await app.page.click("#authorisations-save");
    await app.page.waitForFunction(() => document.querySelector("#authorisations-status")?.textContent?.includes("guardadas"));
    const person = (await (await fetch(app.base + "/api/person")).json()).person;
    assert.equal(person.details.authorisations[0].status, "pending");
  } finally {
    await stopApp(app);
  }
});

test("reviewer: fixed history stores empty arrays when the master history is empty", async () => {
  const app = await startApp();
  try {
    const created = await post(app.base, "/api/person", { full_name: "Synthetic Person", email: "synthetic@example.test" });
    assert.equal(created.status, 201);
    await app.page.click("#person-load");
    await app.page.waitForFunction(() => document.querySelector("#person-status")?.textContent?.includes("Persona actual"));
    await app.page.click("#tab-profiles");
    await app.page.fill("#profile-name", "Empty fixed history");
    await app.page.fill("#profile-focus", "Testing");
    await app.page.locator('input[name="profile-history-mode"][value="fixed"]').check();
    await Promise.all([
      app.page.waitForResponse((r) => r.url().endsWith("/api/profiles") && r.request().method() === "POST"),
      app.page.click("#profile-create"),
    ]);
    const person = (await (await fetch(app.base + "/api/person")).json()).person;
    const profiles = (await (await fetch(app.base + `/api/profiles?personId=${person.id}`)).json()).profiles;
    assert.deepEqual(profiles[0].body.employment_ids, []);
    assert.deepEqual(profiles[0].body.education_ids, []);
  } finally {
    await stopApp(app);
  }
});

test("reviewer: a user correction records user provenance instead of retaining cv-import", async () => {
  const app = await startApp();
  try {
    const created = await post(app.base, "/api/person", { full_name: "Synthetic Person", email: "synthetic@example.test" });
    const personId = (await created.json()).id;
    await post(app.base, "/api/facts", { personId, concept: "english_level", value: "C1", provenance: "cv-import" });
    await app.page.click("#person-load");
    await app.page.waitForFunction(() => (/** @type {HTMLInputElement | null} */ (document.querySelector("#person-facts-list .fact-value")))?.value === "C1");
    const card = app.page.locator("#person-facts-list .profile-card").first();
    await card.locator(".fact-value").fill("C2");
    await card.getByRole("button", { name: "Corregir valor" }).click();
    await app.page.waitForFunction(() => (/** @type {HTMLInputElement | null} */ (document.querySelector("#person-facts-list .fact-value")))?.value === "C2");
    const facts = (await (await fetch(app.base + `/api/facts?personId=${personId}`)).json()).facts;
    assert.equal(facts[0].value, "C2");
    assert.equal(facts[0].provenance, "user");
  } finally {
    await stopApp(app);
  }
});
