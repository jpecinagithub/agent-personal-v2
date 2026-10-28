# Agente personal de empleo v2 — F1 + F2

Single-user job application agent. New baseline, separate from
JobHunter v1 and JOBFORCE. No login, no roles.
Repository of code: PUBLIC. Deployment and data: PRIVATE ONLY
(localhost / private network; the database, the secret store and any
local state are gitignored and never committed).

## Run (private only)

```sh
npm ci            # install dev dependencies (typescript + @types/node) from the lockfile
npm run typecheck # REAL typecheck gate: tsc --allowJs --checkJs --noEmit over apps/, packages/ and tests/
npm test          # full F1 suite (synthetic fixtures only, no real portals)
npm run check     # syntax check only (node --check); this is NOT the typecheck gate
npm start         # binds 127.0.0.1:4101 by default; refuses non-loopback hosts
```

Environment: `PORT` (default 4101), `HOST` (must stay loopback),
`AGENTV2_DATA_DIR` (default `./data`, gitignored), `XAI_API_KEY`
(alternative to the secret store; never commit it).

## Layout

- `apps/server/server.mjs` — HTTP server: health, queue commands, SSE
  events, secrets names only, control-channel origin check on EVERY
  command route, live SSE publication, periodic queue-recovery sweep
  (default 30 s, `recoverIntervalMs` in `createServer`).
- `apps/server/xai-client.mjs` — xAI client: tool definitions and
  `response_format` sent in the request, tool-call arguments parsed and
  validated against the declared parameters schema, tool whitelist,
  error classification, persisted usage and budget. Key from secret
  store or environment only.
- `apps/server/migrations/001_init.sql` — persons, profiles, profile
  snapshots, declared facts, offers, attempts, jobs, events, usage and
  budgets.
- `packages/shared/` — db (transactional profile updates), queue
  (atomic finish, leases + fencing, pause/cancel on claimed jobs),
  events (sequenced + sanitized + live subscribers), secrets
  (AES-256-GCM encrypted store), guard (host allowlist, origin).
- `tests/` — node:test suite. All fixtures are synthetic; no real job
  portal, application, account or LinkedIn automation anywhere.

## Secrets

The secret store is `data/secrets.json`, encrypted with AES-256-GCM
(mode 0600, gitignored). Its encryption key lives in a SEPARATE file,
`data/secrets.key` (mode 0600, gitignored, generated randomly on first
use; override with `AGENTV2_SECRETS_KEY_PATH` or the store's second
constructor argument). A legacy plaintext store is migrated to encrypted
form on load. Losing the key file makes the stored secrets
unrecoverable by design: back the key up separately from the data file,
never in the repo. The API only ever lists secret names. Test values
are obviously fake (`FAKE-TEST-KEY-ONLY`); no real key appears in code,
tests or logs.

## F2: person, profiles, facts, resolution, mappings, UI (see F2-EVIDENCE.md)

- Open the UI at `http://127.0.0.1:4101/` after `npm start`. It is a
  single static page served by the server (no build step) with sections
  for person, profiles and drafts, declared facts, field mappings and
  screening questions. It never touches secret values.
- API under `/api/`: person, profiles (duplicate/archive/unarchive/
  delete, readiness), profile drafts (create/edit/confirm/discard),
  facts, resolve (screening), pending questions and answers, field
  mappings, attempts (pins the profile snapshot AND a whole-person
  snapshot), CV imports (upload preview/confirm/reject), policies,
  consents, xAI status/key, settings (automatic mode). All
  state-changing routes require the private control origin, as in F1.
- Rules enforced by the code, not by convention: at most 10
  NON-DELETED profiles (archiving does not free a slot; deleting is a
  soft delete that never deletes snapshots); profiles hold fact
  references, never fact copies; profile changes are drafts until
  confirmed (new version, effective date, snapshot); answers resolve
  deterministically by concept + scope (declared wins, unscoped-to-
  scoped is a flagged inference, multiple scopes are an ambiguity with
  candidates, missing is asked once); LLM/narrative provenance can
  never create a personal fact; a mapping defined for one source never
  applies to another; readiness (RF-V2-020) requires identity, a
  validated CV, every required policy accepted, the apply-on-behalf
  consent, and xAI available; automatic mode is OFF initially and can
  only be enabled with a ready profile and the auto_apply policy.
- CV import (T-V2-016): upload a PDF, DOCX or TXT file in the UI, see
  the extracted text and detected fields in a preview, then confirm
  (facts become confirmed, CV counts as validated) or reject. Corrupt
  or empty files are never approved; a scanned PDF without a text
  layer is flagged and can never be confirmed.
- Browser tests: `tests/ui-browser.test.mjs` drives the real UI in
  headless Chromium via playwright-core. It needs a Chromium binary:
  set `AGENTV2_CHROMIUM_PATH`, or have the Playwright browser cache
  (this repo was tested against `~/.cache/ms-playwright/chromium-1243`).
  Without a Chromium binary the browser tests fail loudly instead of
  silently substituting API assertions.
- No real personal data is preloaded: the person is entered by the user
  through the UI. All test data is synthetic ("Test Person").

## Gate G1 criteria (see F1-EVIDENCE.md)

Private install, queue and events survive restarts, and secrets appear
in neither UI, logs nor repository. F1 does not send real applications:
that belongs to later phases with real pilots chosen by the user.
