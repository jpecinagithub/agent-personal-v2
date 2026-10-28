# Agente personal de empleo v2 — F1

Private single-user job application agent. New baseline, separate from
JobHunter v1 and JOBFORCE. No login, no roles, private deployment only.

## Run (private only)

```sh
npm test        # full F1 suite (synthetic fixtures only, no real portals)
npm run check   # node --check on every source file
npm start       # binds 127.0.0.1:4101 by default; refuses non-loopback hosts
```

Environment: `PORT` (default 4101), `HOST` (must stay loopback),
`AGENTV2_DATA_DIR` (default `./data`, gitignored), `XAI_API_KEY`
(alternative to the secret store; never commit it).

## Layout

- `apps/server/server.mjs` — HTTP server: health, queue commands, SSE
  events, secrets names only, control-channel origin check.
- `apps/server/xai-client.mjs` — xAI client: structured-output
  validation, tool whitelist, error classification, persisted usage and
  budget. Key from secret store or environment only.
- `apps/server/migrations/001_init.sql` — persons, profiles, profile
  snapshots, declared facts, offers, attempts, jobs, events, usage and
  budgets.
- `packages/shared/` — db, queue (leases + fencing), events (sequenced
  + sanitized), secrets (0600 store), guard (host allowlist, origin).
- `tests/` — node:test suite. All fixtures are synthetic; no real job
  portal, application, account or LinkedIn automation anywhere.

## Secrets

The secret store is `data/secrets.json` (mode 0600, gitignored). The API
only ever lists secret names. Test values are obviously fake
(`FAKE-TEST-KEY-ONLY`); no real key appears in code, tests or logs.

## Gate G1 criteria (see F1-EVIDENCE.md)

Private install, queue and events survive restarts, and secrets appear
in neither UI, logs nor repository. F1 does not send real applications:
that belongs to later phases with real pilots chosen by the user.
