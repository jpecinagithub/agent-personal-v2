// F3 company catalog (T-V2-029, RF-V2-031; design doc 03 section 1).
//
// The catalog is DATA, editable without code changes: boards are added,
// verified, listed and paused through these functions over a db handle
// (node:sqlite, see apps/server/migrations/006_search_catalog.sql).
// Nothing here hard-codes a board into the search path: the search core
// must ask requireVerifiedBoard before consulting a board.
//
// Rules that are not negotiable:
//   - Slug format: ^[a-z0-9][a-z0-9-]*$. Anything else is rejected at
//     add time. A board becomes usable ONLY after verification.
//   - verification is a SEPARATE step from seeding/adding. Seed rows
//     start UNVERIFIED even when F0 observed the board live: F0
//     liveness (2026-10-27) does not carry over, and a board verified
//     once is not verified forever — re-verify to refresh verified_at.
//   - verifyBoard sets verified_at + verified_by ONLY on a successful
//     list call (status "ok" from the matching ATS connector, small
//     limit where the API paginates). Any other outcome records the
//     failure reason in last_error and leaves the row unverified.
//   - A paused board is never usable, even if previously verified.
//   - SmartRecruiters has no connector in F3, so its boards can be
//     catalogued but never verified here (reason "unsupported_ats");
//     they stay unverified rather than being silently approved.
import { randomUUID } from "node:crypto";
import { fetchGreenhouseJobs, fetchLeverPostings, fetchAshbyJobs } from "./ats-connectors.mjs";

export const BOARD_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
export const CATALOG_ATS = ["greenhouse", "lever", "ashby", "smartrecruiters"];
export const CATALOG_REGIONS = ["global", "EU", "unknown"];

/**
 * Seed data transcribed from the F0-verified board catalog
 * (~/workspace/agent-personal-v2-f0/T004-CATALOG.md, 2026-10-27).
 * Board identifiers are normalized to lowercase for the slug rule:
 * F0 records Ashby "Crusoe" and SmartRecruiters "Ubisoft2" with
 * capitals; the stored slugs are "crusoe" and "ubisoft2".
 * Spotify is included although F0 counted it as PARTIAL only (cached
 * copy, pending a fresh refresh): like every other seed row it starts
 * UNVERIFIED, so its presence here claims nothing about liveness.
 * Region is "unknown" for every row: F0 did not record a per-board
 * region, and inventing one would violate RF-V2-031.
 */
export const SEED_BOARDS = [
  // Greenhouse (12, F0 live)
  { company: "Stripe", ats: "greenhouse", board: "stripe", source_url: "https://boards-api.greenhouse.io/v1/boards/stripe/jobs" },
  { company: "Figma", ats: "greenhouse", board: "figma", source_url: "https://boards-api.greenhouse.io/v1/boards/figma/jobs" },
  { company: "Anthropic", ats: "greenhouse", board: "anthropic", source_url: "https://boards-api.greenhouse.io/v1/boards/anthropic/jobs" },
  { company: "BRKZ", ats: "greenhouse", board: "brkz", source_url: "https://boards-api.greenhouse.io/v1/boards/brkz/jobs" },
  { company: "Axi", ats: "greenhouse", board: "axicorpfinancialservicesptyltd", source_url: "https://boards-api.greenhouse.io/v1/boards/axicorpfinancialservicesptyltd/jobs" },
  { company: "CFO Insights", ats: "greenhouse", board: "cfoinsights", source_url: "https://boards-api.greenhouse.io/v1/boards/cfoinsights/jobs" },
  { company: "Connected Cannabis", ats: "greenhouse", board: "connectedcannabis", source_url: "https://boards-api.greenhouse.io/v1/boards/connectedcannabis/jobs" },
  { company: "Madano", ats: "greenhouse", board: "madano", source_url: "https://boards-api.greenhouse.io/v1/boards/madano/jobs" },
  { company: "Broadsign", ats: "greenhouse", board: "broadsign", source_url: "https://boards-api.greenhouse.io/v1/boards/broadsign/jobs" },
  { company: "IFT", ats: "greenhouse", board: "iftother", source_url: "https://boards-api.greenhouse.io/v1/boards/iftother/jobs" },
  { company: "RTB House", ats: "greenhouse", board: "rtbhouse", source_url: "https://boards-api.greenhouse.io/v1/boards/rtbhouse/jobs" },
  { company: "Tide", ats: "greenhouse", board: "tide", source_url: "https://boards-api.greenhouse.io/v1/boards/tide/jobs" },
  // Ashby (5, F0 live)
  { company: "Ramp", ats: "ashby", board: "ramp", source_url: "https://api.ashbyhq.com/job-board-api/job-board/ramp" },
  { company: "Linear", ats: "ashby", board: "linear", source_url: "https://api.ashbyhq.com/job-board-api/job-board/linear" },
  { company: "OpenAI", ats: "ashby", board: "openai", source_url: "https://api.ashbyhq.com/job-board-api/job-board/openai" },
  { company: "Omnea", ats: "ashby", board: "omnea", source_url: "https://api.ashbyhq.com/job-board-api/job-board/omnea" },
  { company: "Crusoe", ats: "ashby", board: "crusoe", source_url: "https://api.ashbyhq.com/job-board-api/job-board/crusoe" },
  // Lever (2 fresh + 1 partial in F0)
  { company: "Palantir", ats: "lever", board: "palantir", source_url: "https://api.lever.co/v0/postings/palantir?mode=json" },
  { company: "Murgado Automotive Group", ats: "lever", board: "murgadoautomotive", source_url: "https://api.lever.co/v0/postings/murgadoautomotive?mode=json" },
  { company: "Spotify", ats: "lever", board: "spotify", source_url: "https://api.lever.co/v0/postings/spotify?mode=json" },
  // SmartRecruiters (1, F0 live; no F3 connector — stays unverified)
  { company: "Ubisoft", ats: "smartrecruiters", board: "ubisoft2", source_url: "https://api.smartrecruiters.com/v1/companies/Ubisoft2/postings" },
];

/** @param {any} row */
function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    company: row.company,
    ats: row.ats,
    board: row.board,
    region: row.region,
    verified_at: row.verified_at,
    verified_by: row.verified_by,
    source_url: row.source_url,
    paused: row.paused === 1 || row.paused === true,
    last_error: row.last_error,
    created_at: row.created_at,
  };
}

/**
 * Add a board. Throws on an invalid slug, an unknown ATS, an invalid
 * region, or a duplicate (ats, board). The row is created UNVERIFIED:
 * adding is not verifying, and an invented slug that happens to match
 * the format still proves nothing until verifyBoard succeeds against
 * the real endpoint.
 * @param {any} db
 * @param {{company: string, ats: string, board: string, region?: string, source_url?: string|null}} input
 */
export function addBoard(db, { company, ats, board, region = "unknown", source_url = null } = /** @type {any} */ ({})) {
  if (!company || typeof company !== "string" || company.trim() === "") throw new Error("company is required");
  if (!CATALOG_ATS.includes(ats)) throw new Error(`unknown ats: ${ats}`);
  if (!BOARD_SLUG_RE.test(board ?? "")) throw new Error(`invalid board slug: ${board}`);
  if (!CATALOG_REGIONS.includes(region)) throw new Error(`invalid region: ${region}`);
  const existing = db.prepare("SELECT id FROM company_boards WHERE ats = ? AND board = ?").get(ats, board);
  if (existing) throw new Error(`board already exists: ${ats}/${board}`);
  const id = randomUUID();
  db.prepare("INSERT INTO company_boards (id, company, ats, board, region, source_url) VALUES (?, ?, ?, ?, ?, ?)").run(id, company.trim(), ats, board, region, source_url);
  return getBoard(db, id);
}

/** @param {any} db @param {string} id */
export function getBoard(db, id) {
  return mapRow(db.prepare("SELECT * FROM company_boards WHERE id = ?").get(id));
}

/** @param {any} db @param {string} ats @param {string} board */
export function getBoardByAtsBoard(db, ats, board) {
  return mapRow(db.prepare("SELECT * FROM company_boards WHERE ats = ? AND board = ?").get(ats, board));
}

/**
 * List boards. By default paused boards are included (the portal needs
 * to see them to unpause); pass includePaused: false to hide them, and
 * onlyVerified: true for the usable set.
 * @param {any} db
 * @param {{includePaused?: boolean, onlyVerified?: boolean}} opts
 */
export function listBoards(db, { includePaused = true, onlyVerified = false } = {}) {
  let sql = "SELECT * FROM company_boards";
  const conditions = [];
  if (!includePaused) conditions.push("paused = 0");
  if (onlyVerified) conditions.push("verified_at IS NOT NULL");
  if (conditions.length > 0) sql += ` WHERE ${conditions.join(" AND ")}`;
  sql += " ORDER BY company ASC";
  return db.prepare(sql).all().map(mapRow);
}

/**
 * Pause or unpause a board. A paused board is never usable, even if
 * previously verified; unpausing does not re-verify it.
 * @param {any} db @param {string} id @param {boolean} paused
 */
export function pauseBoard(db, id, paused = true) {
  const row = getBoard(db, id);
  if (!row) throw new Error("board not found");
  db.prepare("UPDATE company_boards SET paused = ? WHERE id = ?").run(paused ? 1 : 0, id);
  return getBoard(db, id);
}

/**
 * The usability gate for the search core: returns the board only when
 * it exists, is verified (verified_at set) and is not paused.
 * Anything else throws — an unverified board is REJECTED, never
 * silently consulted.
 * @param {any} db @param {string} ats @param {string} board
 */
export function requireVerifiedBoard(db, ats, board) {
  const row = getBoardByAtsBoard(db, ats, board);
  if (!row) throw new Error(`board_not_found: ${ats}/${board}`);
  if (row.paused) throw new Error(`board_paused: ${ats}/${board}`);
  if (!row.verified_at) throw new Error(`board_not_verified: ${ats}/${board}`);
  return row;
}

/**
 * Verify a board against its real ATS list endpoint (small limit where
 * the API paginates). verified_at + verified_by are set ONLY on
 * status "ok"; any other outcome records the reason in last_error and
 * leaves the row unverified. A paused board is not verified (there is
 * nothing to prove about a board that is out of use).
 * @param {any} db @param {string} id
 * @param {{fetchFn?: any, verifiedBy?: string|null, timeoutMs?: number}} opts
 * @returns {Promise<{ok: boolean, boardId: string, status?: string, cause?: string|null, reason?: string, jobsSeen?: number}>}
 */
export async function verifyBoard(db, id, { fetchFn = globalThis.fetch, verifiedBy = null, timeoutMs = 15000 } = {}) {
  const row = getBoard(db, id);
  if (!row) throw new Error("board not found");
  if (row.paused) return { ok: false, boardId: id, reason: "paused" };
  /** @type {any} */
  let result;
  if (row.ats === "greenhouse") result = await fetchGreenhouseJobs(row.board, { fetchFn, timeoutMs, company: row.company });
  else if (row.ats === "lever") result = await fetchLeverPostings(row.board, { fetchFn, timeoutMs, skip: 0, limit: 1, company: row.company });
  else if (row.ats === "ashby") result = await fetchAshbyJobs(row.board, { fetchFn, timeoutMs, company: row.company });
  else {
    db.prepare("UPDATE company_boards SET last_error = ? WHERE id = ?").run("unsupported_ats: no F3 connector for this ATS", id);
    return { ok: false, boardId: id, status: "unavailable", reason: "unsupported_ats" };
  }
  if (result.status === "ok") {
    db.prepare("UPDATE company_boards SET verified_at = ?, verified_by = ?, last_error = NULL WHERE id = ?").run(new Date().toISOString(), verifiedBy, id);
    return { ok: true, boardId: id, status: "ok", jobsSeen: result.jobs.length };
  }
  const reason = `${result.status}: ${result.cause ?? "unknown"}`;
  db.prepare("UPDATE company_boards SET last_error = ? WHERE id = ?").run(reason, id);
  return { ok: false, boardId: id, status: result.status, cause: result.cause, reason };
}

/**
 * Seed the catalog. Rows default to SEED_BOARDS (the F0 catalog) when
 * no rows are given; tests may pass their own rows. Existing
 * (ats, board) pairs are skipped, never overwritten, and every
 * inserted row starts UNVERIFIED — seeding is not verification.
 * @param {any} db
 * @param {Array<{company: string, ats: string, board: string, region?: string, source_url?: string|null}>} rows
 */
export function seedCatalog(db, rows = SEED_BOARDS) {
  let inserted = 0;
  let skipped = 0;
  for (const seed of rows) {
    const board = String(seed.board ?? "").toLowerCase();
    if (getBoardByAtsBoard(db, seed.ats, board)) {
      skipped += 1;
      continue;
    }
    try {
      addBoard(db, { ...seed, board, region: seed.region ?? "unknown" });
      inserted += 1;
    } catch {
      skipped += 1;
    }
  }
  return { inserted, skipped, total: listBoards(db).length };
}
