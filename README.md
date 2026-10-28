# Agente personal de empleo v2 — F1

Private single-user job application agent. New baseline, separate from
JobHunter v1 and JOBFORCE. No login, no roles, private deployment only.

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

## Gate G1 criteria (see F1-EVIDENCE.md)

Private install, queue and events survive restarts, and secrets appear
in neither UI, logs nor repository. F1 does not send real applications:
that belongs to later phases with real pilots chosen by the user.
