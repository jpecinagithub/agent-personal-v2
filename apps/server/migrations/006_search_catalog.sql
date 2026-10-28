-- 006: company board catalog (F3, T-V2-029, RF-V2-031).
-- Boards are data, not code: the catalog grows through the portal,
-- discovery or import, never through a code change. A row is usable
-- only after verification (verified_at set by verifyBoard in
-- packages/shared/company-catalog.mjs); seed rows always start
-- UNVERIFIED, whatever F0 observed live at the time.
-- last_error is NOT one of the pliego's listed columns: it exists so a
-- failed verification records its reason instead of silently leaving
-- the row unverified (T-V2-029: "records the failure reason").
CREATE TABLE IF NOT EXISTS company_boards (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  ats TEXT NOT NULL,
  board TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'unknown' CHECK (region IN ('global', 'EU', 'unknown')),
  verified_at TEXT,
  verified_by TEXT,
  source_url TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (ats, board)
);

CREATE INDEX IF NOT EXISTS idx_company_boards_ats_board ON company_boards (ats, board);
CREATE INDEX IF NOT EXISTS idx_company_boards_verified ON company_boards (verified_at);
