// P1 regression tests for the four defects reproduced by the user on
// 2272185 (G3 review). Each test drives the real pipeline with a mock
// fetch / injected xAI search and synthetic data only — no live boards,
// no real xAI, no user data.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { createProfileFull } from "../packages/shared/profiles.mjs";
import {
  createSearchDefinition,
  updateSearchDefinition,
  runSearchDefinition,
  listSearchRuns,
  listSearchResults,
  buildProfileView,
} from "../packages/shared/search-run.mjs";
import { evaluateOffer } from "../packages/shared/search-filters.mjs";
import { addBoard, verifyBoard } from "../packages/shared/company-catalog.mjs";

const BODY = "We are looking for a candidate to lead the team and manage budgeting, forecasting and reporting across the business. IFRS experience is required for this finance role.";

function resp(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-p1-"));
  return openDatabase(path.join(dir, "agentv2.db"));
}

function makePerson(db, details) {
  return createPersonFull(db, { full_name: "P1 Person", email: "p1@example.test", ...details });
}

function makeProfile(db, personId, body = {}) {
  return createProfileFull(db, personId, "P1", body);
}

function makeDefinition(db, personId, profileId, patch = {}) {
  return createSearchDefinition(db, {
    personId,
    name: "P1",
    profileIds: [profileId],
    titles: { any: ["Finance Manager"] },
    locations: { countries: ["ES"], remoteCountries: ["ES"] },
    workModes: ["remote", "hybrid"],
    offerLanguage: "en",
    sources: ["greenhouse-catalog"],
    schedule: { timezone: "Europe/Madrid", localTimes: ["09:00"], enabled: false },
    action: "save",
    limits: { maxJobs: 100, maxPagesPerSource: 10 },
    ...patch,
  });
}

// --- Defect 1 (T-V2-029): an xAI-discovered job must be validated ---
test("P1: a fabricated xAI discovery never reaches recommended without fetch + validation", async () => {
  const db = freshDb();
  const personId = makePerson(db, {});
  const profileId = makeProfile(db, personId, { desired_roles: ["Finance Manager"], locations: ["ES"], skills: ["IFRS"] });
  const def = makeDefinition(db, personId, profileId, { sources: ["xai-web"] });
  const fetchedUrls = [];
  const fetchFn = async (url) => {
    fetchedUrls.push(String(url));
    return resp(404, { error: "not found" });
  };
  const xaiSearchFn = async () => ({
    jobs: [{
      title: "Finance Manager",
      company: "Invented Corp Ltd",
      canonicalUrl: "https://invented-corp.example.test/jobs/1",
      description: "An invented offer that does not exist.",
    }],
  });
  const out = await runSearchDefinition(db, def.id, { fetchFn, xaiSearchFn });
  assert.equal(out.locked, false);
  assert.ok(fetchedUrls.some((u) => u.includes("invented-corp.example.test")), "validation must attempt to fetch the discovered URL");
  const results = listSearchResults(db, { runId: out.runId });
  assert.ok(results.every((r) => r.status !== "recommended"), "an unvalidated discovery must never be recommended");
  const xaiEntry = out.summary.perSource.find((s) => s.source === "xai-web");
  assert.match(xaiEntry?.cause ?? "", /failed validation\/extraction/, "the drop must be recorded with a reason");
});

// --- Defect 2: the boolean AST must filter titles ---
const AST_AND_NOT_JUNIOR = {
  type: "and",
  children: [
    { type: "phrase", value: '"Finance Manager"' },
    { type: "not", child: { type: "term", value: "Junior" } },
  ],
};

test("P1: boolean AST excludes Junior titles but keeps the rest", async () => {
  const db = freshDb();
  const personId = makePerson(db, {});
  const profileId = makeProfile(db, personId, { desired_roles: ["Finance Manager"], locations: ["ES"], skills: ["IFRS"] });
  const board = addBoard(db, { company: "Acme", ats: "greenhouse", board: "acme" });
  const fetchFn = async (url) => {
    const t = String(url);
    if (t.includes("boards-api.greenhouse.io") && t.includes("/boards/acme/jobs")) {
      return resp(200, [
        { id: "g-fin", title: "Finance Manager", absolute_url: "https://example.test/jobs/g-fin", location: { name: "Hybrid, Logroño, ES" }, updated_at: "2026-10-27T00:00:00Z", content: BODY },
        { id: "g-jun", title: "Finance Manager Junior", absolute_url: "https://example.test/jobs/g-jun", location: { name: "Hybrid, Logroño, ES" }, updated_at: "2026-10-27T00:00:00Z", content: BODY },
      ]);
    }
    return resp(404, { error: "not found" });
  };
  const ver = await verifyBoard(db, board.id, { fetchFn });
  assert.equal(ver.ok, true, JSON.stringify(ver));
  const def = makeDefinition(db, personId, profileId, { booleanAst: AST_AND_NOT_JUNIOR });
  const out = await runSearchDefinition(db, def.id, { fetchFn });
  const results = listSearchResults(db, { runId: out.runId });
  // Map results back to offers via the run's per-profile listing.
  const rankedTitles = new Set(out.perProfile[0].ranked.map((r) => r.offer.title));
  assert.ok(rankedTitles.has("Finance Manager"), "non-Junior title must survive the AST");
  assert.ok(!rankedTitles.has("Finance Manager Junior"), "NOT Junior must exclude the Junior title");
  const junior = results.find((r) => {
    const row = db.prepare("SELECT o.title AS title FROM search_results sr JOIN offers o ON o.id = sr.offer_id WHERE sr.id = ?").get(r.id);
    return row?.title === "Finance Manager Junior";
  });
  assert.equal(junior?.status, "excluded", "the Junior offer must be hard-excluded, not recommended");

  // Unit-level AST semantics: AND/OR/NOT and quoted phrases.
  const base = { title: "Finance Manager" };
  const verdict = evaluateOffer(base, { titleAst: AST_AND_NOT_JUNIOR }, null);
  assert.equal(verdict.perCriterion.titleAst.status, "pass");
  const juniorVerdict = evaluateOffer({ title: "Finance Manager Junior" }, { titleAst: AST_AND_NOT_JUNIOR }, null);
  assert.equal(juniorVerdict.perCriterion.titleAst.status, "fail");
  assert.ok(juniorVerdict.hardFailed.includes("titleAst"));
  const orAst = { type: "or", children: [{ type: "term", value: "Controller" }, { type: "term", value: "Manager" }] };
  assert.equal(evaluateOffer({ title: "Finance Manager" }, { titleAst: orAst }, null).perCriterion.titleAst.status, "pass");
  assert.equal(evaluateOffer({ title: "Controller" }, { titleAst: orAst }, null).perCriterion.titleAst.status, "pass");
  assert.equal(evaluateOffer({ title: "Analyst" }, { titleAst: orAst }, null).perCriterion.titleAst.status, "fail");
  const phraseAst = { type: "phrase", value: '"Finance Manager"' };
  assert.equal(evaluateOffer({ title: "Finance Managerial Assistant" }, { titleAst: phraseAst }, null).perCriterion.titleAst.status, "fail", "a phrase must not match as separate words or a prefix");
});

// --- Defect 3: Lever pagination cursors stay numeric and resume ---
test("P1: Lever pages use numeric skips, stored cursors stay numeric, and a run resumes", async () => {
  const db = freshDb();
  const personId = makePerson(db, {});
  const profileId = makeProfile(db, personId, { desired_roles: ["Finance Manager"], locations: ["ES"], skills: ["IFRS"] });
  const board = addBoard(db, { company: "Lev", ats: "lever", board: "levtest" });
  const requestedSkips = [];
  const requestedUrls = [];
  const leverPosting = (i) => ({
    id: `lv-${i}`, text: "Finance Manager", hostedUrl: `https://example.test/jobs/lv-${i}`,
    applyUrl: `https://example.test/jobs/lv-${i}/apply`,
    categories: { location: "Hybrid, Logroño, ES", commitment: "Full-time", team: "Finance" },
    descriptionPlain: BODY, createdAt: "2026-10-27T00:00:00Z",
  });
  const fetchFn = async (url) => {
    const t = String(url);
    if (t.includes("api.lever.co")) {
      requestedUrls.push(t);
      const parsed = new URL(t);
      const skip = Number(parsed.searchParams.get("skip"));
      const limit = Number(parsed.searchParams.get("limit"));
      requestedSkips.push(skip);
      const page = [];
      const start = Number.isFinite(skip) ? skip : 0;
      const count = start === 0 ? Math.min(limit, 50) : 1;
      for (let i = 0; i < count; i += 1) page.push(leverPosting(start + i));
      return resp(200, page);
    }
    return resp(404, { error: "not found" });
  };
  const ver = await verifyBoard(db, board.id, { fetchFn });
  assert.equal(ver.ok, true, JSON.stringify(ver));
  // Reset the recording after verification (it fetched skip=0, limit=1).
  requestedSkips.length = 0;
  requestedUrls.length = 0;
  const def = makeDefinition(db, personId, profileId, {
    sources: ["lever-catalog"],
    limits: { maxJobs: 100, maxPagesPerSource: 1 },
  });
  const run1 = await runSearchDefinition(db, def.id, { fetchFn });
  assert.deepEqual(requestedSkips, [0], "first run fetches only page 1 under the page budget");
  assert.ok(requestedUrls.every((u) => !u.includes("[object Object]")), "no request may carry an object skip");
  const cursors1 = listSearchRuns(db, { definitionId: def.id }).find((r) => r.id === run1.runId)?.cursors;
  assert.deepEqual(cursors1?.["lever-catalog"]?.levtest, { skip: 50, limit: 50 }, "stored cursor must be numeric, not a corrupted string");
  updateSearchDefinition(db, def.id, { limits: { maxJobs: 100, maxPagesPerSource: 10 } });
  const run2 = await runSearchDefinition(db, def.id, { fetchFn });
  assert.equal(requestedSkips[1], 50, "the resumed run must start from the stored cursor, not from zero");
  assert.ok(requestedUrls.every((u) => !u.includes("[object Object]")));
  const cursors2 = listSearchRuns(db, { definitionId: def.id }).find((r) => r.id === run2.runId)?.cursors;
  assert.equal(cursors2?.["lever-catalog"]?.levtest, null, "after the final page the cursor is null, so a later run restarts");
});

// --- Defect 4: sponsorship need flows from the profile view ---
test("P1: a person needing sponsorship never gets a silent not_applicable", async () => {
  const db = freshDb();
  const personId = makePerson(db, {
    authorisations: [{ country: "ES", status: "authorised", sponsorship_required: true }],
    mobility: "spain",
  });
  const profileId = makeProfile(db, personId, { desired_roles: ["Finance Manager"], locations: ["ES"], skills: ["IFRS"] });
  const view = buildProfileView(db, profileId);
  assert.equal(view.sponsorshipRequired, true, "the view must carry the sponsorship need");
  assert.equal(view.sponsorshipRequiredByCountry.ES, true);
  assert.equal(view.mobility, "spain", "the view must carry mobility through");
  const offer = (sponsorship) => ({
    title: "Finance Manager", company: "Acme",
    location: { country: "ES", region: null, city: "Logroño", raw: null, remote: false },
    workMode: "hybrid", description: BODY, language: "en", sponsorship,
  });
  const criteria = { language: "en", sponsorshipUnknownPolicy: "review" };
  const unknown = evaluateOffer(offer("unknown"), criteria, view);
  assert.equal(unknown.perCriterion.sponsorship.status, "unknown", "no sponsorship info + need => unknown (review), never not_applicable");
  assert.equal(unknown.needsReview, true);
  const incompatible = evaluateOffer(offer("no"), criteria, view);
  assert.equal(incompatible.perCriterion.sponsorship.status, "fail", "incompatible offer + need => hard fail");
  assert.ok(incompatible.hardFailed.includes("sponsorship"));
  const sponsoring = evaluateOffer(offer("yes"), criteria, view);
  assert.equal(sponsoring.perCriterion.sponsorship.status, "pass", "an explicitly sponsoring offer passes");
  // And through a real run: unknown-sponsorship offers are review, not recommended.
  const board = addBoard(db, { company: "Acme", ats: "greenhouse", board: "acme" });
  const fetchFn = async (url) => {
    const t = String(url);
    if (t.includes("boards-api.greenhouse.io") && t.includes("/boards/acme/jobs")) {
      return resp(200, [
        { id: "s-unk", title: "Finance Manager", absolute_url: "https://example.test/jobs/s-unk", location: { name: "Hybrid, Logroño, ES" }, updated_at: "2026-10-27T00:00:00Z", content: BODY },
      ]);
    }
    return resp(404, { error: "not found" });
  };
  const ver = await verifyBoard(db, board.id, { fetchFn });
  assert.equal(ver.ok, true, JSON.stringify(ver));
  const def = makeDefinition(db, personId, profileId, { sponsorshipUnknown: "review" });
  const out = await runSearchDefinition(db, def.id, { fetchFn });
  const results = listSearchResults(db, { runId: out.runId });
  assert.ok(results.length > 0);
  assert.ok(results.every((r) => r.status !== "recommended"), "unknown sponsorship + need must not recommend");
  assert.ok(results.some((r) => r.status === "review"), "unknown sponsorship + need must land in review");
});
