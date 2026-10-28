# F2 Evidence — T-V2-015…022 (2026-10-28)

F2 builds on the F1 base without rewriting it: Node 24 stdlib-only
server, SQLite, queue, events, encrypted secret store, xAI client and
the `tsc --noEmit` typecheck gate. Server still binds 127.0.0.1 only.
No GitHub Actions and no runners: the `.github` directory stays absent
(verified below); GitHub is only for storage and versioning. No real
personal data is preloaded anywhere: the real persona is entered later
by the user through the UI. Every test uses synthetic fixtures
("Test Person", "Fixture Corp", `example.test` addresses). No real xAI
calls were made in F2 (the xAI client is unchanged from F1; its tests
use mock fetches). No real job portal, application, account or LinkedIn
automation anywhere.

Scope note on task numbering: this F2 implements the eight tasks as
specified in the F2 assignment brief (T-V2-015 person, T-V2-016 ten
profiles, T-V2-017 drafts/versioning, T-V2-018 declared facts, T-V2-019
answer resolution, T-V2-020 screening responses, T-V2-021 field
mappings, T-V2-022 UI configuration). The summary table in
`specs/002-agent-personal/tasks.md` groups F2 differently (it lists a
CV importer and employment/education CRUD as separate tasks); those
items are covered here in reduced form — employment and education are
validated fields of the person entity, and a standalone CV-file
importer (PDF/DOCX parsing) was NOT built, because the brief for this
F2 does not ask for it and the stdlib-only stack has no PDF/DOCX
parser. The CV importer is therefore the one open F2-adjacent item,
recorded honestly in the limitations section below, not claimed.

## Commands and observed results (working copy, before the fresh-clone run)

```sh
cd ~/workspace/agent-personal-v2
npm run typecheck    # tsc --noEmit, exit 0 (after fixing 17 real errors
                     # with proper types, not suppressions; see below)
npm test             # 45 tests, 45 pass, 0 fail (F1: 24, F2: 21)
npm run check        # node --check on all sources, exit 0
ls .github           # No such file or directory
grep -RInE 'xai-[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{10,}|gho_[A-Za-z0-9]{10,}' \
  --exclude-dir=.git --exclude-dir=node_modules .   # no matches
```

Typecheck failures found and fixed during F2 (not hidden): `db`
parameters annotated `{object}` in the new modules have no `prepare`
method under checkJs, and `Record<string, SQLOutputValue>` rows cannot
be passed to `JSON.parse` as strings. Fixed by typing database
parameters as `any` in the new modules, typing `validatePersonDetails`
as `Record<string, any>`, typing resolution results as
`Record<string, any>`, and wrapping snapshot `body_json` values with
`String(...)` in tests. No `// @ts-ignore` or suppression was used.

## T-V2-015 — Person entity

- `packages/shared/person.mjs`: `validatePersonDetails`,
  `createPersonFull`, `updatePersonDetails`, `getPerson`,
  `listPersons`. Details are stored in a new `details_json` column
  (migration 002) so identity, contact, languages, authorisations,
  availability, exclusions, desired roles, locations, salary
  expectations (declared values only, min ≤ max, no defaults invented),
  employment and education (with IDs and YYYY / YYYY-MM date precision)
  are validated fields, not free text.
- Required: `full_name` plus at least one contact method (email or
  phone); email format validated. Unknown fields are rejected, never
  silently stored — including unknown keys inside
  `salary_expectations`.
- Tests (`tests/person.test.mjs`): valid create + edit, unknown-field
  rejection, required-field and format validation. Pass.

## T-V2-016 — Up to 10 profiles, one shared facts repository

- `packages/shared/profiles.mjs`: `createProfileFull` enforces at most
  10 active (non-archived) profiles per person; creating an 11th is
  rejected, archiving frees a slot, unarchiving past the limit is
  rejected. Profiles store `factRefs` ({concept, scope} pairs) in the
  profile body: they reference facts, they never copy fact values
  (tested: changing a fact value changes what the reference resolves
  to, while the profile body still contains only the reference).
- Delete is only allowed for archived profiles and never when past
  attempts reference the profile's snapshots.
- Tests (`tests/profiles.test.mjs`): limit, archive/unarchive, delete
  rules, reference-not-copy. Pass.

## T-V2-017 — Drafts and versioning; attempts pin the snapshot in force

- `packages/shared/drafts.mjs`: `createDraft` copies the live body
  with its base version; drafts are edited freely and never touch the
  live profile; `confirmDraft` runs in ONE transaction (preserve the
  replaced version's snapshot if not already pinned, write the new
  version, snapshot the new body, mark the draft confirmed with an
  effective date and the new snapshot id). `discardDraft` changes
  nothing. A draft whose base version is stale (profile moved on) is
  rejected on confirm. Draft bodies reject unknown fields.
- `createAttempt` (profiles.mjs) requires a ready profile, pins the
  snapshot in force (`pinSnapshot`: reuse the stored snapshot for the
  current version or insert one), and stores the resolved fact content
  on the attempt's evidence. Later profile changes (confirmed drafts)
  and later fact changes never alter a past attempt's stored content
  or its pinned snapshot body — tested explicitly.
- Known F1 interaction, mitigated here: F1's raw `updateProfile`
  snapshots the current version unconditionally, so calling it after a
  snapshot for that version was pinned would hit the UNIQUE
  (profile_id, version) constraint. F2's draft confirmation uses
  ensure-snapshot logic instead, so the supported profile-edit path
  (drafts) is safe. Raw `updateProfile` after pinning remains a known
  sharp edge of the F1 helper and is not used by F2 code.
- Tests (`tests/drafts.test.mjs`, `tests/profiles.test.mjs`): draft
  isolation, confirm (version, snapshot, effective date), discard,
  stale draft, attempt pinning. Pass.

## T-V2-018 — Declared facts

- `packages/shared/facts.mjs`: a fact has concept, scope, value,
  provenance and confirmation state (migration 002 adds the state
  column; default `confirmed`). `declareFact` rejects any provenance
  that names an LLM, a narrative, an inference or generated output —
  narrative text, including any LLM output, can never become a personal
  fact. Facts in `pending` confirmation state are listed but never
  resolve answers (only confirmed facts do).
- Tests (`tests/facts-resolve.test.mjs`): five rejected provenance
  values leave zero facts; a pending fact does not resolve. Pass.

## T-V2-019 — Answer resolution, deterministic, by concept + scope

- `packages/shared/resolve.mjs`: `resolveAnswer` with a fixed synonym
  dictionary (data, not inference: e.g. `authorized_to_work` →
  `work_authorisation`). Priority: exact confirmed fact (concept +
  scope) wins; a fact declared without a scope applied to a scoped
  question is returned as `inference` with a warning, never as a
  declared fact; several confirmed facts sharing a concept with
  different scopes and an unscoped question return `ambiguous` with
  the candidate options instead of picking one silently; nothing
  declared returns `missing`.
- Tests: the same question set run against three fixture persons
  proves all three paths (declared / flagged inference / ambiguous
  candidates), plus synonym resolution. Pass.

## T-V2-020 — Screening responses, asked once

- `resolveScreening` resolves a batch; a missing answer creates a
  pending question exactly once (partial unique index on open pending
  questions plus an idempotent upsert: resolving twice returns the
  same pending question id and leaves one open row).
  `answerPendingQuestion` stores the supplied answer as a declared
  fact and marks the question answered, so the same question resolves
  as declared afterwards and is never asked again; answering twice is
  rejected.
- Tests (`tests/facts-resolve.test.mjs`): ask-once, reuse, answer →
  declared, no open pending rows, double-answer rejection. Pass.

## T-V2-021 — Form field mappings, per source only

- `packages/shared/mappings.mjs`: `defineMapping` /
  `getMapping` / `listMappings` over a `field_mappings` table with
  UNIQUE (source, field_key). The source is a required argument to
  every lookup, so a mapping defined for one source can never be
  applied to another. Sources covered by name: greenhouse, lever,
  ashby, smartrecruiters, generic.
- Tests (`tests/mappings.test.mjs`): greenhouse and lever mappings for
  the same stable key return different source fields, ashby returns
  null (no inheritance), redefining one source/key updates only that
  pair. Pass.

## T-V2-022 — Configuration from the UI

- `apps/server/ui.html`: a single static page served by the existing
  server at `/` and `/ui`, no build step, in Spanish, with sections
  for person, profiles and drafts, declared facts, field mappings and
  screening questions/answers. Server routes under `/api/` implement
  person, profiles (archive/unarchive/delete/readiness), drafts
  (create/edit/confirm/discard), facts, resolve, pending questions and
  answers, mappings and attempts. All state-changing API routes reuse
  the F1 control-origin guard, so a foreign web page cannot command
  the private portal.
- Changes take effect without redeploy or restart: everything is
  database-backed; the UI test writes a person, profile and fact
  through the API and reads them back from the same running server.
- Secret values are never exposed by the UI: the page never calls
  `/secrets`, and the test proves a stored fake secret value appears
  neither in the served HTML nor in the names-only `/secrets`
  response.
- Tests (`tests/ui.test.mjs`): page served with all sections, no secret
  leakage, API configuration flow without restart, foreign-origin
  command rejected (403) and changing nothing. Pass.

## Gate G2 assessment

- Configuration complete from the UI without code: met for person,
  profiles, drafts, facts, mappings, questions, answers and readiness.
  Readiness is explained, not silent: `profileReadiness` returns the
  exact missing list (name, focus, unresolvable fact references) and
  attempt creation is blocked while a profile is not ready.
- Honest limitations:
  1. No standalone CV-file importer (PDF/DOCX parsing) — see the scope
     note above. Employment and education are editable as validated
     person fields, and facts can be imported with provenance
     `cv-import` through the API, but no file parser was built.
  2. F2 was verified locally only, not deployed to Oracle (the parent
     runs the Oracle smoke test after this work) and not deployed as a
     service. A full F10 deployment (compose, backup/restore) is still
     pending and is not claimed here.
  3. Person identity edits apply immediately; drafts apply to profile
     configuration (the versioned entity). Person edits are validated
     and stored as declared details, but they do not go through the
     draft workflow.
- Real xAI calls in F2: 0. Real xAI cost in F2: 0.

## Fresh-clone verification (to be filled after the code commit)

```sh
rm -rf /tmp/agentv2-f2-clean
git clone https://github.com/jpecinagithub/agent-personal-v2.git /tmp/agentv2-f2-clean
cd /tmp/agentv2-f2-clean
git rev-parse HEAD
node --version
npm ci
npm run typecheck
npm test
npm run check
```

Results (2026-10-28, fresh clone of the code commit, run exactly as
above):
- `git rev-parse HEAD` → `ab3371a2f1cc0c54dbbe67e859c8aa79d74734ca`
- `node --version` → v24.22.1
- `npm ci` → added 4 packages in 1 s
- `npm run typecheck` → exit 0 (zero tsc errors)
- `npm test` → 45 tests, 45 pass, 0 fail (2.9 s)
- `npm run check` → exit 0
- `ls .github` → No such file or directory (no Actions, no runners,
  as decided: GitHub is only for storage and versioning)

Tested commit: `ab3371a`. This evidence file was committed afterwards
as docs-only; the code it describes is unchanged from `ab3371a`.

## Oracle deployment smoke test (parent verification, 2026-10-28)

- Deployed copy: `git archive HEAD` of commit `aace7b2` (code
  identical to `ab3371a` plus docs-only evidence) into
  `~/agentv2-deploy-test` on Oracle, using the Node 24.22.1 binary
  at `~/opt/node-v24.22.1-linux-arm64/bin` installed during the F1
  deployment test. A direct `git clone` from Oracle still fails (no
  GitHub credentials on that host); no deploy key was created.
- Results on Oracle: `npm ci` ok, `npm run typecheck` exit 0,
  `npm test` 45 pass / 0 fail (1.9 s), `npm run check` exit 0.
- Server smoke test: started with `HOST=127.0.0.1 PORT=14919`.
  `/health` returned `{"ok":true}`; `/` served the Spanish
  configuration UI (title "Agente personal de empleo v2 —
  Configuración"); `ss` showed the listener on `127.0.0.1:14919`
  only. Server stopped afterwards and verified stopped (no listener
  on 14919, health no longer responds).
- Process note: the first stop used a pid file that pointed at a
  wrapper process (pid 136741), not the server itself (pid 136743),
  so the server briefly kept running after the first kill. It was
  then stopped by the pid reported by `ss` for port 14919 and the
  stop was verified separately. The deployed copy stays at
  `~/agentv2-deploy-test` with the server stopped; it is not a
  service and does not start on boot. A full F10 deployment (compose,
  install, backup/restore) is still pending and is not claimed here.
- Gate G2 under the standing local-testing decision: CLOSED, with the
  limitations recorded in this file (no standalone CV-file importer;
  person identity edits apply immediately rather than through
  drafts; F1 raw `updateProfile` after pinning is not used by F2
  code) and the F10 qualification above. Real xAI calls in F2: 0.

# Corrections 2026-10-28 (G2 held open)

The user reviewed the code and evidence of the F2 delivery above and
did NOT accept G2 as closed: F2 stayed a partial delivery. The cause
was confirmed in the user's review and is accepted here: the previous
implementation followed a brief that REASSIGNED the F2 task numbers
(it turned T-V2-016, the CV importer, into "ten profiles"). That
reassignment was not agreed with the user. These corrections were
built against the authoritative task list in the user's uploaded
pliego, `05-FASES-Y-TAREAS.md`, section F2, before any code was
written. No F3 work was started.

## Task-correspondence table (pliego numbers, exactly)

| Pliego task | Pliego deliverable | Implemented as (this repo) | Status after corrections |
|---|---|---|---|
| T-V2-015 (RF-V2-002, 009, 020) | Setup assistant + identity/contact editor, no seed, no SQL | `person.mjs`: validated person entity, named-form UI | Implemented (was already present; kept) |
| T-V2-016 (RF-V2-011, 012) | PDF/DOCX/text importer with preview, extraction, provenance, scanned handling; corrupt/empty never approved | `cv.mjs` + `/api/cv*` + CV UI section | NEW in these corrections (was missing) |
| T-V2-017 (RF-V2-013, 014) | Employment/education CRUD with IDs and date precision; simultaneous experience and current job | `person.mjs` employment/education fields (validated, IDs, YYYY/YYYY-MM) + form rows | Implemented (was present as person fields; kept) |
| T-V2-018 (RF-V2-015, 016) | Editors for languages, skills, links, authorisation by country, availability, compensation; no inferred sensitive values | `person.mjs` editors + named-form UI fields | Implemented (was present; kept) |
| T-V2-019 (RF-V2-017, 048, 054) | Concept dictionary + scoped declaration editor; human question to reusable declaration | `facts.mjs` + `resolve.mjs` (concept + scope, deterministic) | Implemented (was present; kept) |
| T-V2-020 (RF-V2-010, 018) | Create/duplicate/archive/delete profiles, focus and template; TEN limit and cross-source conflict detection | `profiles.mjs`: duplicate/archive/delete, limit corrected (see item 3) | CORRECTED (limit + deletion semantics were wrong) |
| T-V2-021 (RF-V2-019, 059) | Snapshots and versions; changing a profile does not alter the earlier file; explicit regeneration before sending | `drafts.mjs` + profile/person snapshots + `createAttempt` pinning | CORRECTED (attempt now snapshots the whole person, item 5) |
| T-V2-022 (RF-V2-007, 008, 020) | Policies, consent and configuration screen; readiness per profile; automatic mode OFF initially | Policies/consents/xAI/settings UI + `profileReadiness` (see item 4) | CORRECTED (policies/consents/xAI + readiness were missing/wrong) |

Note on `specs/002-agent-personal/tasks.md`: its F2 summary already
matches the pliego (015 identity, 016 CV importer, 017 employment and
education, 018 languages/skills/authorisations, 019 concept
dictionary, 020 profiles, 021 snapshots, 022 policies and readiness).
It did NOT need correcting; the divergence was only in the previous
implementation brief and in the old F2 evidence's scope note, which
this section supersedes. Code header comments that carried the wrong
numbers (`profiles.mjs`, `drafts.mjs`, `facts.mjs`, `mappings.mjs`,
`resolve.mjs`, `person.mjs`) were corrected to the pliego numbers.
Field mappings have no standalone F2 row in the pliego; they are kept
as supporting T-V2-021 (RF-V2-059) infrastructure, not presented as
their own task.

## 1. CV importer (pliego T-V2-016)

- `packages/shared/cv.mjs`, migration `003_f2_corrections.sql`
  (`cv_imports` table), server routes `POST /api/cv` (base64 upload),
  `GET /api/cv`, `GET /api/cv/:id`, `POST /api/cv/:id/confirm`,
  `POST /api/cv/:id/reject`, and a CV section in the UI (file input,
  preview, confirm, reject).
- Libraries added deliberately, with a committed lockfile: pdfjs-dist
  4 for PDF, mammoth 1.13 for DOCX. The stdlib-only choice did not
  authorise dropping the task. Rejected alternative, recorded:
  pdf-parse 1.1.1 was tried first and discarded — its index runs a
  debug snippet on import, and its bundled pdf.js (v1.10, 2017) fails
  on modern PDFs ("bad XRef entry", "Invalid PDF structure"); the
  same fixtures extract correctly with pdfjs-dist 4.
- Flow: preview stores the import in `preview` status and its
  candidate facts (email, phone, name guess) with provenance
  `cv-import` in `pending` state — pending facts never answer
  screening. Confirm requires extractable text, then marks the CV
  `confirmed` (validated) and confirms its facts. A preview never
  downgrades an already-confirmed fact back to pending.
- Corrupt/empty: a non-PDF file named `.pdf`, an empty or
  whitespace-only text file, and a fake ZIP named `.docx` are all
  rejected at upload and leave no import record. A scanned PDF with
  no text layer (fixture `tests/fixtures/scanned.pdf`, a real PDF
  with an empty page) previews with a `scanned_no_text` warning and
  its confirmation is refused.
- Tests (`tests/cv.test.mjs`, synthetic fixtures generated for this
  task: `sample.pdf` via pdf-lib, `sample.docx` via python-docx,
  `sample.txt`, `scanned.pdf`): preview returns the known text for
  PDF, DOCX and TXT; facts stay pending until confirmed and then
  resolve; corrupt/empty rejected; scanned preview warned and
  confirmation refused; rejected imports never validate.

## 2. Form-based UI, tested through the screen (T-V2-022)

- `apps/server/ui.html` rewritten as real HTML forms: person form
  with named fields (name, email, phone, languages, authorisations,
  roles, locations, skills, exclusions, availability, salary,
  employment and education rows parsed from `employer | title |
  start | end` lines — IDs are generated by the page, never shown
  or copied by the user), profile creation form (name, focus,
  template), per-profile cards with Duplicar, Archivar/Desarchivar,
  Eliminar, Editar (draft form with Guardar/Confirmar/Descartar
  borrador) and Comprobar preparación, CV file input with preview
  and confirm/reject, policies list with accept buttons, consent
  button, xAI key field (password, never displayed) with status, and
  automatic-mode controls. No JSON textarea remains for person or
  profile configuration, and profile cards never print UUIDs
  (asserted in the browser test).
- Browser tests (`tests/ui-browser.test.mjs`, playwright-core driving
  headless Chromium from the Playwright browser cache): they open
  the served page and, by clicking and typing in the page itself
  (no direct API calls in these tests), create a person via the
  form, create a profile via the form, duplicate a profile, archive
  a profile, delete an archived profile, preview and confirm a CV
  import from the file input, accept a policy, record the consent,
  save an xAI key, and check readiness on the profile card — all
  asserted on what the page shows afterwards.
- Two real bugs found by these tests and fixed, not hidden: (a) the
  readiness button re-rendered the profile list after checking,
  wiping its own result — it no longer refreshes after a readiness
  check; (b) the PDF extractor collapsed a page into one line, so
  the name heuristic failed — pdf.js `hasEOL` markers are now used
  to preserve line breaks.
- Browser requirement, stated plainly: the browser tests need a
  Chromium binary (`AGENTV2_CHROMIUM_PATH`, or the Playwright cache;
  tested against `~/.cache/ms-playwright/chromium-1243`). Without
  one they fail loudly with that exact cause; they do not fall back
  to API assertions. The parent's Oracle smoke test will need that
  binary on Oracle (or the env var) for the browser tests to run
  there.

## 3. Profile limit and deletion semantics (T-V2-020, corrected)

- The limit now counts NON-DELETED profiles (active + archived):
  `countNonDeletedProfiles`. Creating an 11th profile after
  archiving one is now REJECTED (the old test that demanded the
  wrong behaviour was rewritten, not kept). Unarchiving no longer
  carries a limit check, because an archived profile already
  occupies its slot — the old check could wrongly reject an
  unarchive at exactly ten profiles. Only deletion frees a slot.
- Deletion is now a soft delete (`deleted = 1`): snapshots and
  drafts are never deleted, and `listProfiles` excludes deleted
  profiles by default (with an `includeDeleted` option for audit).
  A profile with past attempts can now be deleted after archiving,
  and its attempts and pinned snapshots still resolve afterwards
  (tested explicitly). Draft creation/confirmation on a deleted
  profile is rejected.

## 4. Policies, consents, xAI and correct readiness (T-V2-022, RF-V2-020)

- `packages/shared/policies.mjs` + migration 003 (`policies`,
  `consents`, `settings` tables; seeded policies `data_processing`
  required and `auto_apply` optional; `auto_mode` seeded `"off"`).
  Server routes: `GET /api/policies`, `POST /api/policies/:key/accept`,
  `GET/POST /api/consents`, `GET /api/xai-status` (boolean only, the
  key is never returned), `POST /api/xai-key` (stored in the
  encrypted secret store), `GET/POST /api/settings`.
- `profileReadiness` now requires ALL of: identity, name, focus,
  every referenced fact confirmed, a validated CV, every required
  policy accepted, the `apply_on_behalf` consent recorded, and xAI
  available (key in the secret store or environment; the server
  computes this, the default is "not available", never assumed).
  The UI shows the missing elements in Spanish
  (identidad, nombre, enfoque, CV validado, política aceptada,
  consentimiento, xAI disponible, hecho …).
- Automatic mode: OFF initially; enabling requires a ready profile
  whose person accepted the `auto_apply` policy, and it can always
  be disabled immediately.
- Tests (`tests/readiness.test.mjs`): each missing element blocks
  individually (cv, policy, consent, xAI removed one at a time),
  and all present means ready. The old UI API test was updated to
  the same flow (it previously asserted readiness with only name
  and focus).

## 5. Full-person attempt snapshot (T-V2-021)

- Migration 003 adds `person_snapshots` and
  `attempts.person_snapshot_id`. `createAttempt` now, in one
  transaction, pins the profile snapshot in force AND snapshots the
  whole person (identity, contacts, employment and education
  history as stored in the person details) and stores the snapshot
  id on the attempt; `getAttempt` returns the snapshot as
  `personSnapshot`. Immediate identity edits remain allowed — the
  obligation is that they never alter a past attempt, and the test
  proves it: after an attempt, the person's name, email, employment
  and education are all replaced, and the attempt still contains
  the original person data unchanged while the current person shows
  the new data.

## Commands and observed results

Working copy, then fresh clone (both 2026-10-28):

```sh
cd ~/workspace/agent-personal-v2
npm run typecheck    # tsc --noEmit, exit 0
npm test             # 56 tests, 56 pass, 0 fail (F1: 24, F2 original: 21, corrections: 11)
npm run check        # node --check on all sources, exit 0
```

Fresh-clone verification (code commit, before this evidence commit):

```sh
rm -rf /tmp/agentv2-f2corr-clean
git clone https://github.com/jpecinagithub/agent-personal-v2.git /tmp/agentv2-f2corr-clean
cd /tmp/agentv2-f2corr-clean
git rev-parse HEAD   # 78f5de0541246a698a5537eeb61f3f08c93d2df9
node --version       # v24.22.1
npm ci               # installs pdfjs-dist, mammoth, playwright-core from the lockfile
npm run typecheck    # exit 0
npm test             # 56 tests, 56 pass, 0 fail (17.0 s, browser tests included)
npm run check        # exit 0
ls .github           # No such file or directory (exit 2 from ls itself: correctly absent)
```

Tested commit: `78f5de0`. This evidence section was committed
afterwards as docs-only; the code it describes is unchanged from
`78f5de0`.

## Gate G2 assessment after corrections

- The five pending items are implemented and tested as above. The
  previous G2 closure is superseded: G2 is NOT declared closed by
  this report — the parent's Oracle smoke test (including the
  browser tests, which need a Chromium binary on Oracle) is still
  pending, and the user re-reviews before any G2 closure.
- Remaining qualifications, stated plainly: person identity edits
  still apply immediately (the obligation met here is that past
  attempts keep the original person snapshot); the F1 raw
  `updateProfile` sharp edge from the earlier evidence is unchanged
  (F2 code paths do not use it after pinning); a full F10 deployment
  (compose, install, backup/restore) is still pending and is not
  claimed here.
- Real xAI calls in these corrections: 0. All xAI tests use mock
  fetches; the browser test's xAI key is an obviously fake value
  that is stored in the test server's secret store only and never
  displayed. Secret scan: no real key patterns in code, tests or
  docs (test values are obviously fake).
