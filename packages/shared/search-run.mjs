// Pliego F3 INTEGRATION: saved-search definitions, the run pipeline
// and the search benchmark, wiring the already-built F3 modules.
//
// What this module does NOT do (G3 gate, binding):
// - It NEVER creates an attempt or a queue candidate. A definition
//   whose action is "auto" is executed as review-only: the run
//   summary states auto-apply is disabled, every stored result is
//   review-only, and score_json.canAutoApply is forced to false.
// - It NEVER reports a failed source as zero results. Partial
//   results are saved even when a source fails, and every source
//   status (completed / failed / rate_limited / blocked /
//   unavailable / partial / assisted / paused) is recorded.
// - It NEVER consults an unverified or paused catalog board for an
//   ATS source, and it never invents an apply URL for an import:
//   imported offers store apply_url "" unless the user supplied one.
// - Ranking uses ONLY the profileView built here from
//   presentedHistory() plus the profile's OWN fields — never the
//   whole person history (T-V2-034 binding).
import { randomUUID } from "node:crypto";
import { validateSearchDefinition } from "./search-presets.mjs";
import { evaluateOffer } from "./search-filters.mjs";
import { dedupeOffers, excludeSent, flagPendingEquivalence, canonicalId, normalizeUrl } from "./search-dedupe.mjs";
import { rankOffers, compareProfiles, summarizeRun } from "./search-rank.mjs";
import { getConnector, compileCriteria } from "./search-registry.mjs";
import { listBoards } from "./company-catalog.mjs";
import { fetchGreenhouseJobs, fetchLeverPostings, fetchAshbyJobs } from "./ats-connectors.mjs";
import { extractOffer, detectLanguage } from "./offer-extract.mjs";
import { generateQueries, validateDiscovery } from "./xai-discovery.mjs";
import { importUrl, importCsv, importText } from "./linkedin.mjs";
import { presentedHistory, getProfileFull } from "./profiles.mjs";
import { getPerson } from "./person.mjs";
import {
  claimRunLock, markSlotRun, recordSourceFailure, recordSourceSuccess,
  isSourceDue, getBackoffState, createBudget, budgetAllowsJob, budgetAllowsPage,
  noteJob, notePage, budgetDeadlineExceeded, DEFAULT_RUN_DEADLINE_MS,
} from "./search-scheduler.mjs";

export { importUrl, importCsv, importText };

const ATS_BY_CONNECTOR = {
  "greenhouse-catalog": "greenhouse",
  "lever-catalog": "lever",
  "ashby-catalog": "ashby",
};

const RUN_FAILURE_STATUSES = new Set(["failed", "rate_limited", "blocked", "unavailable", "partial"]);

// ------------------------------------------------------------------
// Search definitions (search_definitions).
// ------------------------------------------------------------------

/** Strip transport-only keys before validation (they are columns, not definition fields). @param {any} input */
function definitionFields(input) {
  const body = input?.definition && typeof input.definition === "object" ? input.definition : input;
  const { personId, paused, id, version, ...rest } = body ?? {};
  return { fields: rest, personId: input?.personId ?? body?.personId ?? null, paused: Boolean(input?.paused ?? body?.paused ?? false) };
}

/** @param {any} row */
function mapDefinition(row) {
  if (!row) return null;
  const criteria = JSON.parse(row.criteria_json ?? "{}");
  return {
    id: row.id,
    personId: row.person_id ?? null,
    name: row.name,
    profileIds: JSON.parse(row.profile_ids_json ?? "[]"),
    criteria,
    sources: JSON.parse(row.sources_json ?? "[]"),
    schedule: JSON.parse(row.schedule_json ?? "{}"),
    action: row.action,
    limits: JSON.parse(row.limits_json ?? "{}"),
    paused: row.paused === 1,
    version: row.version,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Create a definition. Throws (via validateSearchDefinition) on any
 * invalid field; nothing is silently repaired.
 * @param {any} db @param {any} input definition fields, optionally with personId / definition wrapper
 */
export function createSearchDefinition(db, input) {
  const { fields, personId, paused } = definitionFields(input);
  const validated = validateSearchDefinition(fields);
  const id = randomUUID();
  db.prepare(`INSERT INTO search_definitions
    (id, person_id, name, profile_ids_json, criteria_json, sources_json, schedule_json, action, limits_json, paused)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, personId, validated.name, JSON.stringify(validated.profileIds),
    JSON.stringify(validated), JSON.stringify(validated.sources),
    JSON.stringify(validated.schedule), validated.action,
    JSON.stringify(validated.limits), paused ? 1 : 0,
  );
  return getSearchDefinition(db, id);
}

/** @param {any} db @param {string} id */
export function getSearchDefinition(db, id) {
  return mapDefinition(db.prepare("SELECT * FROM search_definitions WHERE id = ?").get(id));
}

/** @param {any} db @param {{personId?: string}} [opts] */
export function listSearchDefinitions(db, { personId = null } = {}) {
  if (personId) return db.prepare("SELECT * FROM search_definitions WHERE person_id = ? ORDER BY created_at ASC").all(personId).map(mapDefinition);
  return db.prepare("SELECT * FROM search_definitions ORDER BY created_at ASC").all().map(mapDefinition);
}

/**
 * Update a definition: the patch merges onto the stored criteria
 * and the result is fully re-validated; the version bumps.
 * @param {any} db @param {string} id @param {any} patch
 */
export function updateSearchDefinition(db, id, patch) {
  const current = getSearchDefinition(db, id);
  if (!current) throw new Error("search definition not found");
  const { fields, personId, paused } = definitionFields(patch);
  const merged = { ...current.criteria, ...fields };
  const validated = validateSearchDefinition(merged);
  db.prepare(`UPDATE search_definitions SET person_id = ?, name = ?, profile_ids_json = ?,
    criteria_json = ?, sources_json = ?, schedule_json = ?, action = ?, limits_json = ?,
    paused = ?, version = version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(
    personId ?? current.personId, validated.name, JSON.stringify(validated.profileIds),
    JSON.stringify(validated), JSON.stringify(validated.sources),
    JSON.stringify(validated.schedule), validated.action,
    JSON.stringify(validated.limits), patch?.paused !== undefined ? (paused ? 1 : 0) : (current.paused ? 1 : 0), id,
  );
  return getSearchDefinition(db, id);
}

/** @param {any} db @param {string} id */
export function deleteSearchDefinition(db, id) {
  const current = getSearchDefinition(db, id);
  if (!current) throw new Error("search definition not found");
  db.exec("BEGIN IMMEDIATE");
  try {
    const runs = db.prepare("SELECT id FROM search_runs WHERE definition_id = ?").all(id);
    for (const run of runs) db.prepare("DELETE FROM search_results WHERE run_id = ?").run(run.id);
    db.prepare("DELETE FROM search_runs WHERE definition_id = ?").run(id);
    db.prepare("DELETE FROM search_scheduler_state WHERE definition_id = ?").run(id);
    db.prepare("DELETE FROM search_definitions WHERE id = ?").run(id);
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
  return true;
}

/** Duplicate a definition (same criteria, new id, "(copia)" name unless given). @param {any} db @param {string} id @param {string} [name] */
export function duplicateSearchDefinition(db, id, name = null) {
  const current = getSearchDefinition(db, id);
  if (!current) throw new Error("search definition not found");
  return createSearchDefinition(db, {
    ...current.criteria,
    name: name ?? `${current.name} (copia)`,
    personId: current.personId,
    paused: current.paused,
  });
}

/** @param {any} db @param {string} id @param {boolean} [paused] */
export function pauseSearchDefinition(db, id, paused = true) {
  const current = getSearchDefinition(db, id);
  if (!current) throw new Error("search definition not found");
  db.prepare("UPDATE search_definitions SET paused = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(paused ? 1 : 0, id);
  return getSearchDefinition(db, id);
}

// ------------------------------------------------------------------
// Runs and results.
// ------------------------------------------------------------------

/** @param {any} row */
function mapRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    definitionId: row.definition_id,
    status: row.status,
    criteriaSnapshot: JSON.parse(row.criteria_snapshot_json ?? "{}"),
    cursors: JSON.parse(row.cursors_json ?? "{}"),
    counts: JSON.parse(row.counts_json ?? "{}"),
    errors: JSON.parse(row.errors_json ?? "{}"),
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

/** @param {any} db @param {string} id */
export function getSearchRun(db, id) {
  return mapRun(db.prepare("SELECT * FROM search_runs WHERE id = ?").get(id));
}

/** @param {any} db @param {{definitionId?: string}} [opts] */
export function listSearchRuns(db, { definitionId = null } = {}) {
  if (definitionId) return db.prepare("SELECT * FROM search_runs WHERE definition_id = ? ORDER BY started_at DESC").all(definitionId).map(mapRun);
  return db.prepare("SELECT * FROM search_runs ORDER BY started_at DESC").all().map(mapRun);
}

/** @param {any} db @param {{runId?: string, profileId?: string}} [opts] */
export function listSearchResults(db, { runId = null, profileId = null } = {}) {
  let sql = "SELECT r.*, o.title AS offer_title, o.company AS offer_company, o.canonical_url AS offer_canonical_url FROM search_results r LEFT JOIN offers o ON o.id = r.offer_id";
  const conditions = [];
  const params = [];
  if (runId) { conditions.push("r.run_id = ?"); params.push(runId); }
  if (profileId) { conditions.push("r.profile_id = ?"); params.push(profileId); }
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
  sql += " ORDER BY r.created_at ASC";
  return db.prepare(sql).all(...params).map((row) => ({
    id: row.id,
    runId: row.run_id,
    offerId: row.offer_id,
    profileId: row.profile_id,
    score: row.score_json ? JSON.parse(row.score_json) : null,
    reasons: JSON.parse(row.reasons_json ?? "[]"),
    status: row.status,
    created_at: row.created_at,
    offer: row.offer_title !== null && row.offer_title !== undefined
      ? { title: row.offer_title, company: row.offer_company, canonicalUrl: row.offer_canonical_url }
      : null,
  }));
}

// ------------------------------------------------------------------
// Profile views and filter criteria (the T-V2-034 binding).
// ------------------------------------------------------------------

/**
 * Convert stored authorisation statuses (authorised /
 * not_authorised / anything else) to the filter engine's tri-state
 * (yes / no / unknown). Unknown statuses are never normalised to
 * authorised (RF-V2-016).
 * @param {any[]} authorisations
 */
export function authorisationMapFromPerson(authorisations) {
  const map = {};
  for (const entry of authorisations ?? []) {
    if (!entry?.country) continue;
    const status = String(entry.status ?? "").toLowerCase();
    map[String(entry.country).toUpperCase()] = status === "authorised" || status === "yes"
      ? "yes"
      : status === "not_authorised" || status === "no" ? "no" : "unknown";
  }
  return map;
}

/**
 * The profileView for ranking: the profile's OWN fields plus the
 * presented history from presentedHistory(). The whole person
 * history is never attached (a profile that hides financial
 * experience ranks without it).
 * @param {any} db @param {string} profileId
 */
export function buildProfileView(db, profileId) {
  const profile = getProfileFull(db, profileId);
  if (!profile) throw new Error("profile not found");
  const person = getPerson(db, profile.person_id);
  if (!person) throw new Error("person not found");
  const details = person.details ?? {};
  const presented = presentedHistory(details, profile.body ?? {});
  const body = profile.body ?? {};
  // Sponsorship / mobility are carried through, never dropped: the
  // filter engine derives the sponsorship criterion from them (a
  // person who needs sponsorship must never get a silent
  // not_applicable for it), and mobility is the relocation data.
  const sponsorshipRequiredByCountry = {};
  for (const entry of details.authorisations ?? []) {
    if (!entry?.country) continue;
    sponsorshipRequiredByCountry[String(entry.country).toUpperCase()] = entry.sponsorship_required === true;
  }
  return {
    profileId: profile.id,
    name: profile.name,
    fields: {
      desired_roles: body.desired_roles ?? [],
      locations: body.locations ?? [],
      skills: body.skills ?? [],
      exclusions: body.exclusions ?? [],
      salary_expectations: body.salary_expectations ?? {},
    },
    presentedEmployment: presented.employment,
    presentedEducation: presented.education,
    authorisationByCountry: authorisationMapFromPerson(details.authorisations),
    sponsorshipRequired: Object.values(sponsorshipRequiredByCountry).some(Boolean),
    sponsorshipRequiredByCountry,
    mobility: details.mobility ?? null,
  };
}

/** @param {any} value */
function asArray(value) {
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * Map a validated search definition to the filter engine's criteria
 * shape. Absent fields stay absent (not_applicable), never invented:
 * a definition without a salary threshold gets no salary criterion,
 * and a definition without offerLanguage gets no language criterion.
 * An array-form locations list is split heuristically into
 * two-letter country codes vs city names — the only interpretation
 * the filter shape supports — and documented as such.
 * @param {any} definition stored definition wrapper (or its criteria)
 */
export function definitionToCriteria(definition) {
  const def = definition?.criteria ?? definition ?? {};
  const criteria = {};
  if (def.titles !== undefined) criteria.titles = def.titles;
  // The boolean AST participates in filtering (it used to be
  // validated and stored, then discarded): the filter engine
  // evaluates it against the offer title as a hard criterion.
  if (def.booleanAst !== undefined) criteria.titleAst = def.booleanAst;
  const locations = def.locations;
  if (Array.isArray(locations)) {
    const countries = locations.filter((v) => /^[A-Za-z]{2}$/.test(String(v).trim()));
    const cities = locations.filter((v) => !/^[A-Za-z]{2}$/.test(String(v).trim()));
    if (countries.length > 0) criteria.countries = countries;
    if (cities.length > 0) criteria.cities = cities;
  } else if (locations && typeof locations === "object") {
    if (locations.countries) criteria.countries = locations.countries;
    if (locations.regions) criteria.regions = locations.regions;
    if (locations.cities) criteria.cities = locations.cities;
    if (locations.remoteCountries) criteria.remoteCountries = locations.remoteCountries;
  }
  if (def.workModes) criteria.workModes = def.workModes;
  if (def.offerLanguage) criteria.language = def.offerLanguage;
  if (def.seniority) criteria.seniority = asArray(def.seniority);
  if (def.contractTypes) criteria.contractTypes = asArray(def.contractTypes);
  if (def.workingTime) criteria.workingTime = asArray(def.workingTime);
  if (def.sectors) criteria.sectors = asArray(def.sectors);
  if (def.companies) criteria.companies = def.companies;
  if (def.skills) criteria.requiredSkills = def.skills;
  if (def.excludedSkills) criteria.excludedSkills = def.excludedSkills;
  if (def.descriptionTerms) {
    if (Array.isArray(def.descriptionTerms)) criteria.descriptionRequired = def.descriptionTerms;
    else {
      if (def.descriptionTerms.required) criteria.descriptionRequired = def.descriptionTerms.required;
      if (def.descriptionTerms.excluded) criteria.descriptionExcluded = def.descriptionTerms.excluded;
    }
  }
  if (def.salary && typeof def.salary === "object") {
    const min = def.salary.min ?? def.salary.minimum ?? null;
    const max = def.salary.max ?? def.salary.maximum ?? null;
    if (min !== null || max !== null) {
      criteria.salary = {
        min, max,
        currency: def.salary.currency ?? null,
        period: def.salary.period ?? null,
        unknownPolicy: def.salary.unknownPolicy ?? def.salary.unknown ?? "review",
      };
    }
  }
  // Authorisation is profile-side and always checked when a country
  // is known; unknown authorisation is review, never assumed.
  criteria.authorisation = { unknownPolicy: def.authorisationUnknown ?? "review" };
  // Unknown policies for the tri-state criteria the pipeline derives
  // from the profile view (sponsorship need, mobility). The
  // requirements themselves come from the view, not the definition.
  if (def.sponsorshipUnknown !== undefined) criteria.sponsorshipUnknownPolicy = def.sponsorshipUnknown;
  if (def.relocationUnknown !== undefined) criteria.relocationUnknownPolicy = def.relocationUnknown;
  if (typeof def.publishedWithinDays === "number") criteria.publishedWithinDays = def.publishedWithinDays;
  return criteria;
}

// ------------------------------------------------------------------
// Offer upsert (canonical_url UNIQUE; evidence updated, never duplicated).
// ------------------------------------------------------------------

/**
 * Upsert a normalised offer into the offers table. Returns the row
 * id, or null when the offer has neither a canonical nor an apply
 * URL to identify it by (it can still be ranked and stored as a
 * result under its strong key).
 * @param {any} db @param {any} offer normalised offer
 */
export function upsertOffer(db, offer) {
  const canonicalUrl = offer.canonicalUrl ?? offer.applyUrl ?? null;
  if (!canonicalUrl) return null;
  const location = offer.location ?? {};
  const locationText = location.raw
    ?? [location.city, location.region, location.country].filter(Boolean).join(", ");
  const evidence = {
    ...(offer.evidence ?? {}),
    ats: offer.ats ?? null,
    tenant: offer.tenant ?? null,
    postingId: offer.postingId ?? null,
    workMode: offer.workMode ?? null,
    seniority: offer.seniority ?? null,
    description: offer.description ?? "",
    publishedAt: offer.publishedAt ?? null,
    firstSeenAt: offer.firstSeenAt ?? null,
    source: offer.source ?? null,
  };
  const existing = db.prepare("SELECT * FROM offers WHERE canonical_url = ?").get(canonicalUrl);
  if (existing) {
    let mergedEvidence = evidence;
    try { mergedEvidence = { ...JSON.parse(existing.evidence_json ?? "{}"), ...evidence }; } catch { /* keep new evidence */ }
    db.prepare(`UPDATE offers SET source = ?, ats = ?, apply_url = ?, title = ?, company = ?,
      location = ?, language = ?, evidence_json = ? WHERE id = ?`).run(
      offer.source ?? existing.source, offer.ats ?? existing.ats,
      offer.applyUrl ?? existing.apply_url, offer.title ?? existing.title,
      offer.company ?? existing.company, locationText,
      offer.language ?? existing.language, JSON.stringify(mergedEvidence), existing.id,
    );
    return existing.id;
  }
  const id = randomUUID();
  db.prepare(`INSERT INTO offers (id, source, ats, canonical_url, apply_url, title, company, location, language, published_at, evidence_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, offer.source ?? "unknown", offer.ats ?? "", canonicalUrl,
    offer.applyUrl ?? "", offer.title ?? "", offer.company ?? "",
    locationText, offer.language ?? "", offer.publishedAt ?? null, JSON.stringify(evidence),
  );
  return id;
}

// ------------------------------------------------------------------
// LinkedIn / manual imports stored in the offers table.
// ------------------------------------------------------------------

/**
 * Store imported candidates as offers. apply_url is stored exactly
 * as supplied (imports supply null, stored as ""); it is never
 * invented from a canonical URL.
 * @param {any} db @param {any[]} candidates from importUrl/importCsv/importText
 * @returns {any[]}
 */
export function storeImportedCandidates(db, candidates) {
  const stored = [];
  for (const candidate of candidates ?? []) {
    const url = candidate.url ?? candidate.canonicalUrl ?? null;
    if (!url) continue;
    const existing = db.prepare("SELECT id FROM offers WHERE canonical_url = ?").get(url);
    const evidence = {
      provenance: candidate.provenance ?? "linkedin-import",
      mode: "assisted",
      easyApplyExecuted: false,
      status: candidate.status ?? null,
      extraction: candidate.extraction ?? null,
      description: candidate.description ?? "",
      language: candidate.language ?? null,
    };
    let offerId;
    if (existing) {
      db.prepare("UPDATE offers SET title = ?, company = ?, location = ?, language = ?, evidence_json = ? WHERE id = ?").run(
        candidate.title ?? "", candidate.company ?? "", candidate.location ?? "",
        candidate.language ?? "", JSON.stringify(evidence), existing.id,
      );
      offerId = existing.id;
    } else {
      offerId = randomUUID();
      db.prepare(`INSERT INTO offers (id, source, ats, canonical_url, apply_url, title, company, location, language, evidence_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        offerId, candidate.provenance ?? "linkedin-import", "", url,
        candidate.applyUrl ?? "", candidate.title ?? "", candidate.company ?? "",
        candidate.location ?? "", candidate.language ?? "", JSON.stringify(evidence),
      );
    }
    stored.push({
      offerId, url, title: candidate.title ?? null, company: candidate.company ?? null,
      status: candidate.status ?? null, provenance: candidate.provenance ?? "linkedin-import",
      applyUrl: candidate.applyUrl ?? "",
    });
  }
  return stored;
}

// ------------------------------------------------------------------
// The run pipeline.
// ------------------------------------------------------------------

/** Map a connector failure status to a recorded per-source status. @param {string} status */
function mapConnectorStatus(status) {
  if (["rate_limited", "blocked", "unavailable"].includes(status)) return status;
  return "failed";
}

/**
 * Fetch one ATS source from its verified catalog boards only.
 * startCursors resumes pagination: { [board]: { skip, limit } | number }
 * from a previous run's stored cursors. A board whose stored cursor is
 * null (fully paged) restarts at 0; a stored numeric skip resumes
 * there. Cursors are ALWAYS kept numeric — assigning a cursor object
 * wholesale to skip produced skip=[object Object] and corrupted the
 * stored cursor.
 * @param {any} db @param {string} ats @param {any} fetchFn @param {any} budget @param {string} sourceId @param {any} [startCursors]
 * @returns {Promise<{jobs: any[], cursors: any, boardErrors: any[], status: string, cause: string | null, retryAfterMs: number | null}>}
 */
async function fetchAtsSource(db, ats, fetchFn, budget, sourceId, startCursors = {}) {
  const boards = listBoards(db, { onlyVerified: true, includePaused: false }).filter((b) => b.ats === ats);
  if (boards.length === 0) {
    return { jobs: [], cursors: {}, boardErrors: [], status: "failed", cause: `no verified catalog boards for ${ats}`, retryAfterMs: null };
  }
  const jobs = [];
  const cursors = {};
  const boardErrors = [];
  for (const board of boards) {
    if (budgetDeadlineExceeded(budget) || !budgetAllowsJob(budget)) break;
    if (ats === "greenhouse" || ats === "ashby") {
      if (!budgetAllowsPage(budget, sourceId)) break;
      notePage(budget, sourceId);
      const result = ats === "greenhouse"
        ? await fetchGreenhouseJobs(board.board, { fetchFn, company: board.company })
        : await fetchAshbyJobs(board.board, { fetchFn, company: board.company });
      if (result.status !== "ok") {
        boardErrors.push({ board: board.board, status: result.status, cause: result.cause, retryAfterMs: result.retryAfterMs ?? null });
        continue;
      }
      cursors[board.board] = result.cursor ?? null;
      for (const job of result.jobs) {
        if (!budgetAllowsJob(budget)) break;
        noteJob(budget);
        jobs.push(job);
      }
    } else if (ats === "lever") {
      // Resume from the stored cursor for this board when one exists.
      const stored = startCursors?.[board.board];
      let skip = 0;
      if (typeof stored === "number" && Number.isFinite(stored)) skip = stored;
      else if (stored && typeof stored === "object" && Number.isFinite(Number(stored.skip))) skip = Number(stored.skip);
      let cursor = null;
      for (;;) {
        if (budgetDeadlineExceeded(budget) || !budgetAllowsJob(budget) || !budgetAllowsPage(budget, sourceId)) break;
        notePage(budget, sourceId);
        const result = await fetchLeverPostings(board.board, { fetchFn, skip, limit: 50, company: board.company });
        if (result.status !== "ok") {
          boardErrors.push({ board: board.board, status: result.status, cause: result.cause, retryAfterMs: result.retryAfterMs ?? null });
          break;
        }
        cursor = result.cursor ?? null;
        for (const job of result.jobs) {
          if (!budgetAllowsJob(budget)) break;
          noteJob(budget);
          jobs.push(job);
        }
        if (cursor === null || cursor === undefined) break;
        // The connector cursor is { skip, limit } (or a bare number):
        // extract the numeric offset, never the object itself.
        const next = typeof cursor === "object" && cursor !== null ? Number(cursor.skip) : Number(cursor);
        if (!Number.isFinite(next)) break;
        skip = next;
      }
      cursors[board.board] = cursor;
    }
  }
  if (boardErrors.length > 0 && jobs.length === 0) {
    const statuses = [...new Set(boardErrors.map((e) => e.status))];
    const status = statuses.length === 1 ? mapConnectorStatus(statuses[0]) : "failed";
    const retryAfterMs = boardErrors.find((e) => e.retryAfterMs !== null)?.retryAfterMs ?? null;
    return { jobs, cursors, boardErrors, status, cause: boardErrors.map((e) => `${e.board}: ${e.cause ?? e.status}`).join("; "), retryAfterMs };
  }
  if (boardErrors.length > 0) {
    return { jobs, cursors, boardErrors, status: "partial", cause: boardErrors.map((e) => `${e.board}: ${e.cause ?? e.status}`).join("; "), retryAfterMs: null };
  }
  return { jobs, cursors, boardErrors, status: jobs.length === 0 ? "completed_zero_results" : "completed", cause: null, retryAfterMs: null };
}

/**
 * Run one saved search definition synchronously (for now).
 *
 * xai-web runs ONLY when xaiSearchFn is provided; the server passes
 * it only when xAI is verified, so without it the source records
 * { status: "failed", cause: "xai not verified" }. linkedin-assisted
 * and manual-import contribute no live jobs and record "assisted".
 * AUTO-APPLY STAYS DISABLED (G3): action "auto" is executed as
 * review-only and the summary says so; no attempt or queue
 * candidate is ever created here.
 *
 * @param {any} db
 * @param {string} definitionId
 * @param {{fetchFn?: any, xaiSearchFn?: ((queries: string[]) => Promise<any>) | null, xaiClassifyFn?: ((text: string) => Promise<any>) | null, deadlineMs?: number, slotKey?: string | null, nowMs?: number}} [opts]
 */
export async function runSearchDefinition(db, definitionId, opts = {}) {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const definition = getSearchDefinition(db, definitionId);
  if (!definition) throw new Error("search definition not found");
  const criteria = definitionToCriteria(definition);
  const claim = claimRunLock(db, definitionId, definition.criteria);
  if (claim.locked) return { locked: true, runId: claim.runId, definitionId };
  const runId = claim.runId;
  // Resume: cursors from the most recent FINISHED run of this
  // definition (the current run row has no finished_at yet, so it
  // is excluded). A stored non-null cursor continues pagination;
  // a null cursor means that board was fully paged and restarts.
  const previousCursors = (() => {
    try {
      const prev = listSearchRuns(db, { definitionId }).find((r) => r.id !== runId && r.finished_at);
      return prev?.cursors ?? {};
    } catch { return {}; }
  })();
  const budget = createBudget(definition.limits, { deadlineMs: opts.deadlineMs ?? DEFAULT_RUN_DEADLINE_MS, nowMs: opts.nowMs ?? Date.now() });
  try {
    // Profile views (presented history + own fields only).
    const profileViews = definition.profileIds.map((profileId) => buildProfileView(db, profileId));
    const personId = definition.personId ?? (definition.profileIds.length > 0 ? (getProfileFull(db, definition.profileIds[0])?.person_id ?? null) : null);
    // Already-sent canonical ids for this person (attempts join).
    const sentIds = new Set();
    if (personId) {
      const sentRows = db.prepare(`SELECT o.canonical_url AS canonical_url, o.evidence_json AS evidence_json
        FROM attempts a LEFT JOIN offers o ON o.id = a.offer_id WHERE a.person_id = ?`).all(personId);
      for (const row of sentRows) {
        if (row.canonical_url) {
          const url = normalizeUrl(row.canonical_url);
          if (url) sentIds.add(`url:${url}`);
        }
        try {
          const evidence = JSON.parse(row.evidence_json ?? "{}");
          if (evidence.ats && evidence.tenant && evidence.postingId) {
            sentIds.add(`ats:${String(evidence.ats).toLowerCase()}|tenant:${String(evidence.tenant).toLowerCase()}|posting:${String(evidence.postingId).toLowerCase()}`);
          }
        } catch { /* evidence is best-effort */ }
      }
    }
    criteria.sentCanonicalIds = [...sentIds];

    // Per-source fetching. A failed source is recorded, never
    // rendered as zero results; partial results still flow on.
    const perSource = [];
    const cursors = {};
    const sourceErrors = {};
    let allOffers = [];
    let budgetExhausted = false;
    for (const sourceId of definition.sources) {
      if (budgetDeadlineExceeded(budget)) {
        budgetExhausted = true;
        perSource.push({ source: sourceId, status: "failed", observed: 0, valid: 0, duplicates: 0, excluded: 0, pending: 0, cause: "budget: deadline exceeded" });
        continue;
      }
      if (!isSourceDue(db, definitionId, sourceId)) {
        const backoff = getBackoffState(db, definitionId)[sourceId];
        perSource.push({ source: sourceId, status: "failed", observed: 0, valid: 0, duplicates: 0, excluded: 0, pending: 0, cause: `backoff: next attempt at ${backoff?.nextAttemptAt ?? "unknown"}` });
        continue;
      }
      const connector = getConnector(sourceId);
      if (!connector) {
        perSource.push({ source: sourceId, status: "failed", observed: 0, valid: 0, duplicates: 0, excluded: 0, pending: 0, cause: `unknown connector: ${sourceId}` });
        continue;
      }
      if (connector.status === "paused") {
        perSource.push({ source: sourceId, status: "paused", observed: 0, valid: 0, duplicates: 0, excluded: 0, pending: 0, cause: "connector paused" });
        continue;
      }
      const ats = ATS_BY_CONNECTOR[sourceId];
      if (ats) {
        const fetched = await fetchAtsSource(db, ats, fetchFn, budget, sourceId, previousCursors[sourceId] ?? {});
        cursors[sourceId] = fetched.cursors;
        if (fetched.boardErrors.length > 0) sourceErrors[sourceId] = fetched.boardErrors;
        if (fetched.status === "completed" || fetched.status === "completed_zero_results") recordSourceSuccess(db, definitionId, sourceId);
        else if (fetched.boardErrors.length > 0 && fetched.jobs.length === 0) {
          recordSourceFailure(db, definitionId, sourceId, { retryAfterMs: fetched.retryAfterMs ?? null });
        }
        perSource.push({ source: sourceId, status: fetched.status, observed: fetched.jobs.length, valid: 0, duplicates: 0, excluded: 0, pending: 0, cause: fetched.cause });
        allOffers = allOffers.concat(fetched.jobs);
        if (!budgetAllowsJob(budget) && fetched.jobs.length > 0) budgetExhausted = budget.truncated;
        continue;
      }
      if (sourceId === "xai-web") {
        if (!opts.xaiSearchFn) {
          perSource.push({ source: sourceId, status: "failed", observed: 0, valid: 0, duplicates: 0, excluded: 0, pending: 0, cause: "xai not verified" });
          continue;
        }
        try {
          const titles = Array.isArray(definition.criteria.titles) ? definition.criteria.titles : (definition.criteria.titles?.any ?? []);
          const locations = definition.criteria.locations;
          const locationList = Array.isArray(locations) ? locations : (locations?.countries ?? []);
          const queries = generateQueries({ titles, locations: locationList });
          const discovered = await opts.xaiSearchFn(queries);
          let urls = [];
          if (Array.isArray(discovered)) urls = discovered.filter((v) => typeof v === "string");
          else if (Array.isArray(discovered?.urls)) urls = discovered.urls;
          const discoveredJobs = Array.isArray(discovered?.jobs) ? discovered.jobs : (Array.isArray(discovered) ? discovered.filter((v) => v && typeof v === "object") : []);
          const extracted = [];
          let extractFailures = 0;
          for (const url of urls) {
            if (!budgetAllowsJob(budget)) break;
            const result = await extractOffer(url, { fetchFn, classifyFn: opts.xaiClassifyFn ?? null });
            if (result.status !== "ok") { extractFailures += 1; continue; }
            noteJob(budget);
            extracted.push({
              source: "xai-web", ats: "xai-web", tenant: (() => { try { return new URL(result.url).hostname; } catch { return "unknown"; } })(),
              postingId: null, canonicalUrl: result.url, applyUrl: "",
              title: result.title ?? "unknown", company: result.company ?? null,
              location: { country: null, region: null, city: null, raw: null, remote: false },
              workMode: "unknown", seniority: null, contractType: null, workingTime: null, sector: null,
              description: result.description ?? "", skills: [],
              salary: { min: null, max: null, currency: null, period: null, published: false },
              language: result.language ?? null, languageMethod: result.languageMethod ?? null,
              sponsorship: "unknown", relocation: "unknown", publishedAt: result.publishedAt ?? null,
              firstSeenAt: result.firstSeenAt, evidence: { canonicalVerified: true, ...(result.evidence ?? {}) },
            });
          }
          // Discovered jobs go through the SAME validation pipeline
          // as every other candidate (T-V2-029): an LLM assertion is
          // never an offer. Each job's URL is validated against its
          // asserted title/company AND fully extracted; anything
          // unvalidated or unextractable is dropped with a recorded
          // reason and never reaches eligibility/ranking.
          let discoveryFailures = 0;
          for (const job of discoveredJobs) {
            if (!budgetAllowsJob(budget)) break;
            const url = job.canonicalUrl ?? job.url ?? null;
            if (!url) { discoveryFailures += 1; continue; }
            const validation = await validateDiscovery(url, { fetchFn, expectedTitle: job.title ?? null, expectedCompany: job.company ?? null });
            if (!validation.verified) { discoveryFailures += 1; continue; }
            const result = await extractOffer(url, { fetchFn, classifyFn: opts.xaiClassifyFn ?? null });
            if (result.status !== "ok") { discoveryFailures += 1; continue; }
            noteJob(budget);
            extracted.push({
              source: "xai-web", ats: "xai-web", tenant: (() => { try { return new URL(result.url).hostname; } catch { return "unknown"; } })(),
              postingId: null, canonicalUrl: result.url, applyUrl: "",
              title: result.title ?? "unknown", company: result.company ?? null,
              location: { country: null, region: null, city: null, raw: null, remote: false },
              workMode: "unknown", seniority: null, contractType: null, workingTime: null, sector: null,
              description: result.description ?? "", skills: [],
              salary: { min: null, max: null, currency: null, period: null, published: false },
              language: result.language ?? null, languageMethod: result.languageMethod ?? null,
              sponsorship: "unknown", relocation: "unknown", publishedAt: result.publishedAt ?? null,
              firstSeenAt: result.firstSeenAt, evidence: { canonicalVerified: true, discoveryVerified: true, ...(result.evidence ?? {}) },
            });
          }
          const failureNotes = [];
          if (extractFailures > 0) failureNotes.push(`${extractFailures} discovered URL(s) failed extraction`);
          if (discoveryFailures > 0) failureNotes.push(`${discoveryFailures} discovered job(s) failed validation/extraction and were dropped`);
          if (failureNotes.length > 0) sourceErrors[sourceId] = [...(sourceErrors[sourceId] ?? []), ...failureNotes.map((reason) => ({ reason }))];
          perSource.push({ source: sourceId, status: "completed", observed: urls.length + discoveredJobs.length, valid: 0, duplicates: 0, excluded: 0, pending: 0, cause: failureNotes.length > 0 ? failureNotes.join("; ") : null });
          allOffers = allOffers.concat(extracted);
        } catch (err) {
          recordSourceFailure(db, definitionId, sourceId, {});
          perSource.push({ source: sourceId, status: "failed", observed: 0, valid: 0, duplicates: 0, excluded: 0, pending: 0, cause: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      if (sourceId === "linkedin-assisted" || sourceId === "manual-import") {
        perSource.push({ source: sourceId, status: "assisted", observed: 0, valid: 0, duplicates: 0, excluded: 0, pending: 0, cause: "assisted: no live jobs; offers arrive via the import endpoints" });
        continue;
      }
      // A known connector with no fetch path in this pipeline.
      perSource.push({ source: sourceId, status: "failed", observed: 0, valid: 0, duplicates: 0, excluded: 0, pending: 0, cause: `no fetch path for connector: ${sourceId}` });
    }

    // Language detection for offers that do not already carry one
    // (ATS listings rarely state it). Only a confident local
    // detection is trusted; otherwise the language stays unknown and
    // the filter marks it for review — never guessed.
    for (const offer of allOffers) {
      if (!offer.language && offer.description) {
        const detected = detectLanguage(offer.description);
        if (detected.language !== "unknown" && detected.confidence >= 0.6 && detected.hits >= 5) {
          offer.language = detected.language;
          offer.languageMethod = "local";
        }
      }
    }

    // Dedupe (strong identity only), then already-sent exclusion,
    // then pending-equivalence flagging (weak groups stay for review
    // and are never auto-sendable — and nothing here auto-sends).
    const { unique, duplicates, uncertainGroups } = dedupeOffers(allOffers);
    const { kept, excluded: sentExcluded } = excludeSent(unique, sentIds);
    const pendingKeys = new Set(uncertainGroups.map((g) => g.key));
    const { flagged: pendingOffers } = flagPendingEquivalence(kept, pendingKeys);
    const pendingCanonical = new Set(pendingOffers.map((o) => canonicalId(o)).filter(Boolean));

    // Persist offers (first occurrence wins; evidence updated).
    const offerIdByIdentity = new Map();
    for (const offer of unique) {
      const id = upsertOffer(db, offer);
      const key = canonicalId(offer) ?? normalizeUrl(offer.canonicalUrl ?? offer.applyUrl ?? "") ?? offer.title;
      if (id) offerIdByIdentity.set(key, id);
      if (id) offerIdByIdentity.set(offer, id);
    }
    const resolveOfferId = (offer) => {
      if (offerIdByIdentity.has(offer)) return offerIdByIdentity.get(offer);
      const key = canonicalId(offer) ?? normalizeUrl(offer.canonicalUrl ?? offer.applyUrl ?? "") ?? offer.title;
      return offerIdByIdentity.get(key) ?? key ?? "unknown";
    };

    // Rank per profile; persist one result row per (offer, profile).
    const perProfile = [];
    const insertResult = db.prepare("INSERT INTO search_results (id, run_id, offer_id, profile_id, score_json, reasons_json, status) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const autoNote = "auto-apply is disabled (G3 gate): this result is review-only";
    for (const view of profileViews) {
      const { ranked, excluded } = rankOffers(kept, view, criteria);
      const rankedByOffer = new Map(ranked.map((r) => [r.offer, r]));
      const excludedByOffer = new Map(excluded.map((e) => [e.offer, e]));
      for (const offer of kept) {
        const verdict = evaluateOffer(offer, criteria, view);
        const reasons = Object.values(verdict.perCriterion).map((c) => c.evidence);
        const scored = rankedByOffer.get(offer);
        let status;
        let scoreJson = null;
        if (excludedByOffer.has(offer)) {
          status = "excluded";
          scoreJson = { total: null, components: null, needsReview: verdict.needsReview, canAutoApply: false, autoApplyDisabled: true };
        } else if (pendingCanonical.has(canonicalId(offer)) || offer.pendingEquivalence) {
          status = "pending";
          scoreJson = scored ? { total: scored.total, components: scored.components, needsReview: scored.needsReview, canAutoApply: false, autoApplyDisabled: true } : null;
        } else if (scored) {
          status = scored.needsReview ? "review" : "recommended";
          scoreJson = { total: scored.total, components: scored.components, needsReview: scored.needsReview, canAutoApply: false, autoApplyDisabled: true };
        } else {
          status = "excluded";
          scoreJson = { total: null, components: null, needsReview: verdict.needsReview, canAutoApply: false, autoApplyDisabled: true };
        }
        insertResult.run(randomUUID(), runId, String(resolveOfferId(offer)), view.profileId, scoreJson ? JSON.stringify(scoreJson) : null, JSON.stringify([...reasons, autoNote]), status);
      }
      for (const entry of sentExcluded) {
        const offer = entry.offer;
        insertResult.run(randomUUID(), runId, String(resolveOfferId(offer)), view.profileId, null, JSON.stringify(["already_sent: offer was already sent by this person (canonical identity)", autoNote]), "excluded");
      }
      perProfile.push({
        profileId: view.profileId,
        ranked: ranked.map((r) => ({ offer: { title: r.offer.title, company: r.offer.company, canonicalUrl: r.offer.canonicalUrl }, total: r.total, needsReview: r.needsReview })),
        excludedCount: excluded.length,
        sentExcludedCount: sentExcluded.length,
        pendingCount: pendingOffers.length,
      });
    }

    // Per-source aggregates attributed by the surviving offer's source.
    // NOTE (parent fix, F3 integration review): ATS normalizers stamp
    // offers with the ATS id ("greenhouse"), while perSource is keyed
    // by connector id ("greenhouse-catalog"); without this reverse
    // lookup every per-source valid/duplicates/excluded/pending count
    // stayed 0 even on completed runs (RF-V2-039).
    const ATS_TO_CONNECTOR = Object.fromEntries(Object.entries(ATS_BY_CONNECTOR).map(([c, a]) => [a, c]));
    const bySource = new Map(perSource.map((s) => [s.source, s]));
    const resolveSourceEntry = (offer) => bySource.get(offer.source) ?? bySource.get(ATS_TO_CONNECTOR[offer.source]) ?? null;
    for (const entry of perSource) {
      entry.valid = 0; entry.duplicates = 0; entry.excluded = 0; entry.pending = 0;
    }
    for (const offer of kept) {
      const entry = resolveSourceEntry(offer);
      if (entry) entry.valid += 1;
      if (pendingCanonical.has(canonicalId(offer)) || offer.pendingEquivalence) {
        if (entry) entry.pending += 1;
      }
    }
    for (const entry of duplicates) {
      const sourceEntry = resolveSourceEntry(entry.offer);
      if (sourceEntry) sourceEntry.duplicates += 1;
    }
    for (const entry of sentExcluded) {
      const sourceEntry = resolveSourceEntry(entry.offer);
      if (sourceEntry) sourceEntry.excluded += 1;
    }
    // Hard-excluded offers are counted once, against their source,
    // from the first profile's ranking (exclusion is profile-shaped,
    // but the count must not multiply by the number of profiles).
    if (profileViews.length > 0) {
      const first = rankOffers(kept, profileViews[0], criteria);
      for (const entry of first.excluded) {
        const sourceEntry = resolveSourceEntry(entry.offer);
        if (sourceEntry) sourceEntry.excluded += 1;
      }
    }

    const summaryBase = summarizeRun(perSource, definition.sources);
    const comparison = compareProfiles(kept, profileViews, criteria);
    const anyFailure = perSource.some((s) => RUN_FAILURE_STATUSES.has(s.status));
    const runStatus = anyFailure ? "partial" : "completed";
    const counts = {
      observed: allOffers.length,
      unique: unique.length,
      duplicates: duplicates.length,
      uncertainGroups: uncertainGroups.length,
      kept: kept.length,
      sentExcluded: sentExcluded.length,
      pending: pendingOffers.length,
      budgetTruncated: budget.truncated || budgetExhausted,
      perSource,
    };
    const errors = {
      perSource: sourceErrors,
      autoApply: definition.action === "auto"
        ? "definition action 'auto' was executed as review-only: auto-apply is disabled (G3 gate)"
        : "auto-apply is disabled (G3 gate)",
    };
    db.prepare("UPDATE search_runs SET status = ?, cursors_json = ?, counts_json = ?, errors_json = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
      runStatus, JSON.stringify(cursors), JSON.stringify(counts), JSON.stringify(errors), runId,
    );
    if (opts.slotKey) markSlotRun(db, definitionId, opts.slotKey);
    const summary = {
      ...summaryBase,
      runStatus,
      autoApplyDisabled: true,
      actionRequested: definition.action,
      actionExecuted: definition.action === "auto" ? "review" : definition.action,
      autoApplyNote: errors.autoApply,
      perSource,
      uncertainGroups: uncertainGroups.map((g) => ({ key: g.key, count: g.offers.length })),
    };
    return {
      locked: false,
      runId,
      definitionId,
      run: getSearchRun(db, runId),
      summary,
      perProfile,
      comparison: comparison.results.map((r) => ({
        offer: { title: r.offer.title, company: r.offer.company, canonicalUrl: r.offer.canonicalUrl },
        scores: r.scores.map((s) => ({ profileId: s.profileId, total: s.total, eligible: s.eligible })),
        bestProfileId: r.bestProfileId,
        bestTotal: r.bestTotal,
      })),
    };
  } catch (err) {
    db.prepare("UPDATE search_runs SET status = 'interrupted', errors_json = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), runId,
    );
    throw err;
  }
}

// ------------------------------------------------------------------
// Search benchmark (T-V2-034): computed over an annotated corpus,
// never a universality percentage.
// ------------------------------------------------------------------

/** Synthetic benchmark profile + criteria, mirroring the annotated corpus's expectations (tests/search-rank.test.mjs). */
export const BENCHMARK_PROFILE = {
  profileId: "profile-finance",
  name: "Finance",
  fields: {
    desired_roles: ["Finance Manager", "FP&A Manager", "Financial Controller"],
    locations: ["ES", "IE", "NL", "Logroño", "Dublin", "Amsterdam"],
    skills: ["FP&A", "IFRS"],
    exclusions: ["Intern"],
    salary_expectations: { currency: "EUR", min: 50000, max: 80000, period: "year" },
  },
  presentedEmployment: [
    { id: "job-1", employer: "Acme Test Corp", title: "Finance Manager", start: "2020-01", end: "2025-12" },
    { id: "job-2", employer: "Globex Test Ltd", title: "FP&A Analyst", start: "2018-01", end: "2019-12" },
  ],
  presentedEducation: [
    { id: "edu-1", institution: "Fixture University", title: "BSc Finance", start: "2014", end: "2018" },
  ],
  authorisationByCountry: { ES: "yes", IE: "yes", NL: "yes", US: "no", DE: "unknown" },
};

export const BENCHMARK_CRITERIA = {
  countries: ["ES", "IE", "NL"],
  remoteCountries: ["ES"],
  workModes: ["remote", "hybrid", "onsite"],
  language: "en",
  salary: { min: 40000, currency: "EUR", period: "year", unknownPolicy: "review" },
  companies: { blocked: ["Blocked Test Corp"] },
  excludedSkills: ["COBOL"],
  excludedTitles: ["Intern"],
  sponsorship: { requires: true, unknownPolicy: "review" },
  authorisation: { unknownPolicy: "review" },
};

/**
 * Run the benchmark over a parsed fixture ({ offers, sentStrongKey }).
 * Metrics are counts and a top-20 precision fraction on THIS corpus
 * only — they say nothing about recall over the whole internet.
 * @param {any} benchmark
 */
export function runSearchBenchmark(benchmark) {
  const offers = benchmark?.offers ?? [];
  const criteria = { ...BENCHMARK_CRITERIA, sentCanonicalIds: benchmark?.sentStrongKey ? [benchmark.sentStrongKey] : [] };
  const view = BENCHMARK_PROFILE;
  const { ranked, excluded } = rankOffers(offers, view, criteria, { now: "2026-10-28T00:00:00Z" });
  const rankedIds = new Set(ranked.map((r) => r.offer.id));
  const falsePasses = offers.filter((o) => o.expected?.excluded === true && rankedIds.has(o.id));
  const annotatedExcluded = offers.filter((o) => o.expected?.excluded === true);
  const { unique, duplicates, uncertainGroups } = dedupeOffers(offers);
  const unknownDateOffers = offers.filter((o) => o.expected?.category === "unknown-date");
  let markedUnknown = 0;
  const unmarkedIds = [];
  for (const offer of unknownDateOffers) {
    const scored = ranked.find((r) => r.offer.id === offer.id);
    if (scored && scored.components.preferencesRecency.unknown) markedUnknown += 1;
    else unmarkedIds.push(offer.id);
  }
  const top20 = ranked.slice(0, 20);
  const top20Correct = top20.filter((r) => r.offer.expected?.excluded !== true).length;
  return {
    benchmarkVersion: benchmark?.version ?? null,
    totalOffers: offers.length,
    rankedCount: ranked.length,
    excludedCount: excluded.length,
    annotatedExcludedCount: annotatedExcluded.length,
    hardExclusionFalsePasses: falsePasses.length,
    falsePassIds: falsePasses.map((o) => o.id),
    dedupe: { total: offers.length, unique: unique.length, duplicates: duplicates.length, uncertainGroups: uncertainGroups.length },
    unknownDate: { total: unknownDateOffers.length, markedUnknown, unmarked: unmarkedIds.length, unmarkedIds },
    top20: { size: top20.length, correct: top20Correct, precision: top20.length > 0 ? top20Correct / top20.length : null },
  };
}

/** Compile view helper for the server: native / postprocessed / unsupported per connector. @param {any} definition */
export function compileViewForDefinition(definition) {
  const criteria = definitionToCriteria(definition);
  return (definition.sources ?? []).map((sourceId) => {
    try {
      return { connector: getConnector(sourceId), compile: compileCriteria(criteria, sourceId) };
    } catch (err) {
      return { connector: getConnector(sourceId), compile: null, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
