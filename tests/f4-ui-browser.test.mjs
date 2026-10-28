// F4 UI in a real browser (T-V2-035..040): the "Análisis y plan"
// section is present, in Spanish, and its chat-tools button shows
// the real tool catalogue from the server. If no Chromium executable
// is available, the test fails loudly with the exact cause.
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
      "browser automation unavailable: no Chromium executable found in the Playwright cache "
      + "(set AGENTV2_CHROMIUM_PATH or run `npx playwright install chromium`)",
    );
  }
  return found;
}

test("F4 UI: the 'Análisis y plan' section renders and its chat-tools button shows real tools", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-f4browser-"));
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
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    const heading = await page.textContent("#f4-section h2");
    assert.equal(heading, "Análisis y plan");
    const sectionText = await page.textContent("#f4-section");
    assert.ok(sectionText.includes("nunca envía nada"), "the section states it never submits");
    assert.ok(sectionText.includes("autoaplicación sigue desactivada"));
    await page.click("#f4-chat-tools");
    await page.waitForFunction(() => {
      const el = document.getElementById("f4-chat-tools-out");
      return el && el.textContent.includes("analyse_url");
    });
    const toolsOut = await page.textContent("#f4-chat-tools-out");
    assert.ok(toolsOut.includes("choose_profile"));
    assert.ok(toolsOut.includes("consult_results"));
  } finally {
    await browser.close();
    server.close();
  }
});
