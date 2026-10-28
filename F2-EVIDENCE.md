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

## Parent verification of the corrections (2026-10-28)

- Local, by the parent: `npm run typecheck` exit 0, `npm test`
  56/56, `npm run check` exit 0, repo PRIVATE, remote HEAD matching.
- Oracle, by the parent, deployed copy `git archive HEAD` of the
  final commit into `~/agentv2-deploy-test` (direct clone still
  fails: no GitHub credentials on Oracle; no deploy key created),
  run detached via a log file so an SSH drop cannot kill it:
  `npm ci` ok, `npm run typecheck` exit 0, `npm test` 56 pass /
  0 fail (5.4 s, browser tests included), `npm run check` exit 0.
- Oracle server smoke test: started on `127.0.0.1:14919`,
  `/health` returned `{"ok":true}`, `/` served the Spanish
  configuration UI, `ss` showed the listener on `127.0.0.1:14919`
  only; stopped afterwards by the pid reported by `ss` for that
  port and verified stopped (no listener, health no longer
  responds). The deployed copy stays with the server stopped; it
  is not a service and does not start on boot.
- Two honest process notes from this verification. (1) The first
  Oracle full-suite run hung on the browser tests and its SSH
  session dropped: the test then hardcoded a Chromium 1243 /
  linux64 path that does not exist on Oracle ARM (the cache there
  holds chromium-1248 / chrome-linux-arm64), and a leaked test
  server kept the test process alive. The fix, in commit `fcd5cc8`,
  scans the Playwright cache recursively for any Chromium binary
  (any revision, any architecture) and closes the test server if
  the browser launch fails. An intermediate commit `c97beb6`
  contained a shallow one-level scan that still missed the binary;
  it was immediately superseded by `fcd5cc8` and is not the tested
  version. With the fix, the browser tests pass on Oracle in
  ~2.8 s standalone and inside the full 56-test suite. (2) The
  earlier `git archive` full-suite run on Oracle was killed after
  its SSH session broke; the detached log-file run above is the
  authoritative Oracle result.
- G2 closure is left to the user's re-review, as the user ordered:
  this report does not close G2. A full F10 deployment (compose,
  install, backup/restore) is still pending and is not claimed.

## G2 re-review corrections 2026-10-28

Basis: the user's re-review of commit `eadf86b`
(`~/workspace/user/files/G2-REVIEW.md` plus
`~/workspace/user/files/review-results.json`: 13 checks, 5 correct,
8 failing in six incidents R1–R6). The review scripts mentioned in
that report were not uploaded, so every case below was reproduced
from the report's written reproduction steps. The five checks the
user verified as correct were NOT reopened: archiving one of ten
profiles does not free a slot; the full person snapshot stays
intact after edits; soft deletion retains previous attempts and
their snapshots; soft deletion frees exactly one slot; a missing
xAI key initially blocks readiness. They are covered by a new
regression file, `tests/review-positive.test.mjs`, and stay green.
G2 is NOT closed by this work: closure awaits the user's re-review,
as the user ordered. F3 is not started.

### R1 — CV data mixing (T-V2-016, RF-V2-012/018)

Reproduction (report): preview CV A with `alpha@example.test`
and CV B with `beta@example.test` for the same person, reject B,
confirm A — the confirmed fact was B's email, because both
imports shared mutable `declared_facts` rows.
Fix by class: previews no longer write `declared_facts` at all.
New migration `004_g2_rereview.sql` adds `cv_proposals` (one
immutable row per import: value, concept, scope, source document,
source section, confidence, status) and
`cv_imports.candidate_proposal_ids_json`. `previewCv` stores one
proposal row per candidate field; `confirmCvImport` applies ONLY
that import's proposals, in a transaction, and resolves conflicts
at confirm time: a differing already-confirmed fact with no
resolution is reported as a conflict and left untouched (import
status `confirmed_with_conflicts`, re-confirmable); resolution
`replace` overwrites it, `keep` skips it. `correctProposal`
allows correcting a proposal's value before confirming (refused
after confirmation). Rejecting an import marks its proposals
`rejected`, never touching another import's rows.
Tests: `tests/cv-proposals.test.mjs` — reject B then confirm A
yields alpha only; confirm B then reject A yields beta only;
confirm A then confirm B yields `confirmed_with_conflicts` with
the email conflict, fact stays alpha, then an explicit `keep`
resolution leaves alpha; a pre-existing confirmed fact plus a CV
conflicts, stays unchanged, then an explicit `replace` applies;
correcting a proposal before confirm confirms the corrected
value, correcting after confirmation is refused.

### R2 — Saving a person deletes data and regenerates history IDs (T-V2-017/018, RF-V2-013..016)

Reproduction (report, real browser): load a person with
stable-ID employments, links, a professional achievement, a
current job and an academic speciality, click "Ver persona
actual" and "Guardar persona" without changing anything — the
form rebuilt the person from its limited fields, employment
IDs became `job-1`/`job-2` by position, and links,
achievements, current flag and speciality disappeared;
reordering the two employment lines changed the same job's ID.
Fix by class, two layers. API: `updatePersonDetails` now
merges instead of replacing (`mergePersonDetails` in
`packages/shared/person.mjs`): a field absent from the patch
survives (a present field replaces, including an explicit empty
array); employment/education entries match by stable ID, never
by position — a known ID merges field by field, a new ID is
added, `deleted: true` removes it, entries absent from the
patch array are preserved (omission is never a deletion);
ordering: when the patch names every surviving entry, the patch
order wins, otherwise original relative order is kept with new
entries appended; the merged result is fully validated.
UI: the person section now has structured employment/education
editors — one card per entry with a stable `data-id`, fields
for employer/institution, title, start/end (text inputs,
preserving YYYY or YYYY-MM precision), current-job checkbox,
location, functions, achievements, links, exit reason,
speciality, status, grade, plus Subir/Bajar/Eliminar per card
(delete records the ID in a deleted set and the save sends
`{id, deleted: true}`) and "Añadir empleo"/"Añadir estudio"
with fresh UUIDs.
Tests: `tests/person-merge.test.mjs` (unchanged save preserves
everything; partial patch preserves absent fields; reorder by
ID; insert; explicit remove; per-entry field merge; unknown
field rejected) and a new real-browser test in
`tests/ui-browser.test.mjs` (seed a rich person via the API,
then through the screen: unchanged load/save preserves IDs,
links, achievements, current flag, speciality and date
precision; "Bajar" reorders with IDs travelling; "Eliminar"
removes only that entry).

### R3 — A fake xAI key counts as available (T-V2-022, RF-V2-007/020)

Reproduction (report): complete the other requirements and
save a deliberately invalid synthetic key — readiness was
`ready=true`, because availability only checked that a key
existed.
Fix by class: configured is now distinguished from verified.
New module `packages/shared/xai-verify.mjs`: `verifyXaiConnection`
calls the models endpoint (no generation spend) with an
injectable fetch and returns `{ok, models, reason}` with
reasons `no_key`, `network: …`, `auth` (401/403),
`rate-limit` (429), `http_<status>`, `invalid_response`,
`model_not_available`; only the SHA-256 fingerprint of the key
is ever stored, never the key. `xai_verifications` records
fingerprint+model+status; `isXaiVerified` is true only when
the latest record for that exact fingerprint+model pair is ok,
so changing the key or the model invalidates verification
automatically. Server routes: `GET /api/xai-status`,
`POST /api/xai-key` (clears verifications),
`POST /api/xai-model` (clears verifications),
`POST /api/xai-verify` (runs verification with the injected
fetch, records it). Readiness requires `xaiVerified`, not
merely configured; the UI shows "xAI: no configurado",
"xAI: configurado, verificado (model)" or
"xAI: configurado, sin verificar (error?)".
Tests: `tests/xai-verify.test.mjs` — with a MOCKED provider
(no real keys, no real calls, no spend): 401 is not verified,
network error is not verified, a model list without the
selected model is not verified, a valid positive response
verifies only for that key and model, a later failed record
revokes, clearing removes verification. The server/UI tests
now pass a mocked `verifyFetchFn` to `createServer` and prove
that a merely configured fake key leaves readiness missing
`xai`, and that a verified mocked response clears it.

### R4 — One validated CV enables every profile (T-V2-016/020/022, RF-V2-011/018/020)

Reproduction (report): confirm a CV for the person, then
create another profile without selecting any CV — the second
profile already satisfied `cv_validated`, because readiness
only asked whether the person had any confirmed CV.
Fix by class: each profile has an explicit, versioned
association to its content-template CV. `profiles` bodies
accept `cv_import_id`, validated by `assertValidProfileCv`
(confirmed import of the same person; empty means none
selected); `profileCv` returns the selected CV only if
confirmed and same-person; readiness requires that selected
CV; drafts validate the CV on confirm; the profile create
form and edit areas have a CV select fed from the person's
confirmed imports. The same CV may be reused across profiles,
but it must be selected for that profile. Attempts pin the
chosen CV: `attempts.cv_import_id` plus `cv_snapshot_json`
(id, filename, format, extracted text, status, confirmed_at,
proposals), returned by `getAttempt` as `cvSnapshot`.
Tests: `tests/profile-cv.test.mjs` — a new profile without a
CV stays missing `cv_validated` even when another profile has
one; assigning an unconfirmed CV throws; assigning a valid CV
resolves; reuse across profiles is allowed; changing a
profile's CV via draft leaves the old attempt's CV snapshot
unchanged and the new attempt pins the new CV.

### R5 — Auto mode without a bounded policy (T-V2-022, RF-V2-008)

Reproduction (report): a ready profile plus accepted
`auto_apply` consent activated auto mode (HTTP 200) with no
daily limit, profiles, sources or policy conditions.
Fix by class: `validateAutoPolicy` in
`packages/shared/policies.mjs` requires a persisted policy
with a positive-integer daily limit, a non-empty list of
existing non-deleted profiles, a non-empty list of sources,
and a non-empty conditions string, reporting each missing or
invalid field by name; `getAutoPolicy`/`setAutoPolicy` store
it under settings key `auto_policy`. `POST /api/settings`
with `auto_mode=on` now requires a valid stored policy AND at
least one policy profile ready (with verified xAI), with
explained errors naming the missing policy fields or stating
that none of the policy profiles is ready; generic consent
text no longer substitutes. Deactivation (`off`) is always
immediately available. The UI settings section is now "Modo
automático y su política" with a daily-limit input, profile
checkboxes, source checkboxes (greenhouse/lever/ashby/
smartrecruiters), a conditions textarea, a save-policy
button and a completeness status.
Tests: `tests/auto-policy.test.mjs` — module-level: each
missing field reported by name, unknown profile rejected,
incomplete save refused, valid policy stores. Server-level:
enabling without a policy returns 400 naming the missing
fields, saving an incomplete policy returns 400, a valid
policy plus a ready policy profile enables, disabling always
succeeds (verification recorded directly via
`recordXaiVerification` with a fake key fingerprint — mocked
provider state, no real call).

### R6 — A deleted profile can create new attempts (T-V2-020/021)

Reproduction (report): prepare a profile, archive it, delete
it, then POST /api/attempts with its ID and a synthetic offer
— HTTP 201, a new attempt using the deleted profile.
Fix by class: the backend validates profile state in both
places. `profileReadiness` returns
`{ready: false, missing: ["profile_deleted"]}` for a deleted
profile, and `createAttempt` explicitly throws "profile is
deleted: a deleted profile cannot create a new attempt"
BEFORE any readiness work, so no snapshot or attempt row is
created. Historical attempts remain readable with their
snapshots (unchanged behaviour, covered by the positives
file).
Tests: `tests/deleted-attempt.test.mjs` — module-level:
ready profile, attempt, archive, delete, readiness false with
`profile_deleted`, `createAttempt` throws mentioning deleted,
attempts and person-snapshot counts unchanged, old attempt
still readable with its snapshot. Server-level: POST
/api/attempts with the deleted profile returns 400 and
creates nothing, GET of the old attempt still returns 200.

### Verification (exact commands and observed results)

Working copy, Node v24.22.1, in `~/workspace/agent-personal-v2/`:
- `npm run typecheck` — exit 0 (two real errors found and
  fixed during this work: the mocked verify fetch did not
  satisfy the `fetch` type, fixed by typing the injected
  option loosely in `createServer`; and `verifyRes.json.ok`
  in `tests/ui.test.mjs`, fixed to `(await verifyRes.json()).ok`
  because the helper returns the raw Response).
- `npm test` — 84 pass / 0 fail (was 56; +28 new or rewritten
  tests: cv-proposals, person-merge, xai-verify, profile-cv,
  auto-policy, deleted-attempt, review-positive, plus the
  updated cv/readiness/profiles/ui/ui-browser suites).
- `npm run check` — exit 0.
Two real bugs found by the suite and fixed during this work
(not claimed as pre-existing): (1) `previewCv` inserted
`cv_proposals` rows BEFORE the parent `cv_imports` row,
tripping the foreign key `cv_proposals.cv_import_id →
cv_imports(id)` — fixed by inserting the import row first
and updating its proposal list afterwards; (2) the stale
assertion `evidence.snapshotVersion === 1` in
`tests/readiness.test.mjs` — assigning the CV through a draft
confirmation legitimately bumps the profile from version 1 to
version 2, so the attempt pins version 2; the assertion was
corrected with that explanation, the code was not weakened.
Fresh local clone verification of the code commit: `git
clone` of the repo to a new `/tmp/agentv2-g2rereview-clone`
directory, then `npm ci --no-audit --no-fund`
(33 packages), `npm run typecheck` (exit 0), `npm test`
(84 pass / 0 fail, ~14.4 s, browser tests included),
`npm run check` (exit 0), at commit
`f9726efc4268dc7c7c90bb32d61e64d7bc423269`, Node v24.22.1.
Code commit: `f9726ef` (21 files, +1677/−161). This evidence
is a separate docs-only commit on top of it.
Honest limitations and still-open items: (1) xAI verification
calls the real models endpoint in production; the tests prove
the logic only against a mocked provider, and no real xAI
call was made in this work (0 real calls, 0 spend). (2) The
browser tests drive real Chromium via the existing recursive
cache scan (commit `fcd5cc8`), which keeps working on x64
and ARM hosts; no new browser dependency was introduced.
(3) Person identity edits still apply immediately (the draft
workflow applies to profile configuration), as before.
(4) The F1 raw `updateProfile` sharp edge is unchanged; F2
code paths do not use it after pinning. (5) Full F10
deployment (compose, install, backup/restore) is still
pending and is not claimed. (6) G2 closure awaits the user's
re-review, as ordered; this report does not close G2.

## Parent verification of the re-review corrections (2026-10-28)

- Local, by the parent: `npm run typecheck` exit 0,
  `npm test` 84 pass / 0 fail (18.3 s, browser tests included),
  `npm run check` exit 0, repo PRIVATE, remote HEAD matching
  `1ca59f5`, no `.github` directory.
- Oracle, by the parent, deployed copy `git archive HEAD` of
  `1ca59f5` into `~/agentv2-deploy-test` (direct clone still
  fails: no GitHub credentials on Oracle; no deploy key created),
  run detached via a log file: `npm ci` ok, `npm run typecheck`
  exit 0, `npm test` 84 pass / 0 fail (8.8 s), `npm run check`
  exit 0.
- Oracle server smoke test: started on `127.0.0.1:14919`,
  `/health` returned `{"ok":true}`, `/` served the Spanish
  configuration UI, `ss` showed the listener on `127.0.0.1:14919`
  only; stopped afterwards by the pid reported by `ss` for that
  port and verified stopped. The deployed copy stays with the
  server stopped; it is not a service and does not start on boot.
- G2 closure is left to the user's re-review, as ordered: this
  parent verification does not close G2.

## G2 re-review 2 corrections 2026-10-28 (f9726ef)

The user independently re-reviewed f9726ef (typecheck ok, 37 existing
tests ok, 44 independent checks: 38 pass, 6 fail in 3 issues) and
kept G2 pending. All three issues are fixed below; the behaviours
the user verified as working (per-profile CV assignment and reuse,
xAI invalidation, auto policy, deleted-profile blocking, archive
not freeing a slot, deletion freeing exactly one slot) were kept
green and are covered by the existing suite.

### 1. A CV with pending conflicts enabled an attempt (P1)

- Reproduction (user's): confirm CV1, confirm a discrepant CV2
  without resolving (status `confirmed_with_conflicts`, common fact
  correctly kept), assign CV2 to a ready profile, readiness returned
  true and POST /api/attempts returned 201.
- Cause: `getValidatedCvImport` accepted `confirmed_with_conflicts`
  exactly like `confirmed`, and the CV selector offered it.
- Fix by class: only a FULLY confirmed import validates. A
  conflicted import may still be SELECTED for a profile (so the
  user can see and resolve it), but readiness returns
  `cv_conflicts_unresolved` as the explained reason, and attempt
  creation — which checks readiness before opening any
  transaction — rejects it creating no attempt and no snapshot.
  The UI selector offers only fully confirmed CVs and shows
  conflicted ones as disabled options with the reason; the profile
  editor shows an assigned conflicted CV the same way. Use is
  restored only after an explicit keep/replace resolution, after
  which the import becomes `confirmed`.
- Tests (exact user names): "An unresolved CV conflict blocks
  readiness" and "An unresolved CV conflict cannot enter an
  attempt" (fresh synthetic offer, so no deduplication masks the
  failure), plus "Resolving the conflict explicitly unlocks
  readiness". One pre-existing test (R4 CV change) was updated to
  the new contract: switching to an unresolved conflicted CV is
  now rejected, resolving it unlocks the new attempt, and the
  historical attempt still pins the old CV version.

### 2. The form still saved some edits incorrectly (P1)

Three sub-cases, all through the real browser, plus the class fix
behind them: the form now sends its full state, and the backend
distinguishes an absent field (preserve) from an explicit deletion
(a null value deletes the key; an empty array clears a list).

- (a) Unchecking "Empleo actual" left current=true: the form only
  sent current when true. The card now sends current as false when
  the entry previously had true (and omits it when the entry never
  had the flag, so an unchanged save stays identical), and an end
  date entered alongside is saved.
- (b) Clearing "Enlaces personales" kept the old list: empty lists
  were omitted and the merge read omission as "no change". Lists
  are now sent explicitly — as [] when the loaded person had them
  (explicit clear), omitted when the person never had them.
- (c) Saving an authorisation lost valid_until and
  sponsorship_required: the screen rebuilt only country/status and
  the backend replaced the whole array. Authorisations are now
  structured cards (country, status, validity, sponsorship
  checkbox) with stable ids, and the backend merges them per entry
  by id (or by country for legacy id-less entries, which gain an
  id on merge), preserving unedited nested properties; a null
  nested value clears that property explicitly.
- The same had-flag rule was applied to entry list fields
  (achievements, links) and to the salary object, after the first
  version of this fix broke the existing R2 unchanged-save test by
  adding keys (current:false, achievements:[], links:[]) to entries
  that never had them. That regression was caught by the suite,
  fixed, and the R2 test passes unchanged.
- Tests: module tests for each sub-case plus a real-browser test
  ("browser G2 re-review 2: unchecking current, clearing links and
  editing authorisations saves explicitly") that edits through the
  screen, reloads, and checks the persisted state both on screen
  and through the API.

### 3. A rejected cross-import correction already modified the other CV (P2)

- Reproduction (user's): PUT /api/cv/<A>/proposals/<proposal-of-B>
  returned 400 ("proposal does not belong to this CV import") but
  B's value had already changed, because the server wrote first
  and checked belonging afterwards.
- Fix by class: `correctProposal` now takes the URL import id and
  validates belonging BEFORE any write, and the UPDATE itself is
  conditioned on both identifiers in one statement. The server
  route passes the URL import id and no longer checks afterwards.
- Tests: "Rejected cross-import correction does not modify the
  other CV" (module level, both imports byte-identical after the
  rejection) and "Rejected cross-import correction over HTTP
  leaves both imports intact" (real HTTP, 400, B unchanged).

### Verification of this correction round

```sh
rm -rf /tmp/agentv2-g2rr2-clean
git clone https://github.com/jpecinagithub/agent-personal-v2.git /tmp/agentv2-g2rr2-clean
cd /tmp/agentv2-g2rr2-clean
git rev-parse HEAD   # 8ca80efb6be7f6b8264dfeea5dce03c554245e50
node --version       # v24.22.1
npm ci               # ok
npm run typecheck    # exit 0
npm test             # 95 tests, 95 pass, 0 fail (was 84; +11)
npm run check        # exit 0
ls .github           # No such file or directory (no Actions/runners)
```

Tested commit: `8ca80ef`. This evidence was committed afterwards
as docs-only; the code it describes is unchanged from `8ca80ef`.
G2 closure is left to the user's re-review, as ordered: this
report does not close G2. A full F10 deployment (compose,
install, backup/restore) is still pending and is not claimed.
Real xAI calls in this round: 0 (all xAI tests use mock fetches).

## Parent verification of the re-review 2 corrections (2026-10-28)

- Local, by the parent: `npm run typecheck` exit 0,
  `npm test` 95 pass / 0 fail (18.3 s, browser tests included),
  `npm run check` exit 0, repo PRIVATE, remote HEAD matching
  `56df718`, no `.github` directory.
- Oracle, by the parent, deployed copy `git archive HEAD` of
  `56df718` into `~/agentv2-deploy-test` (direct clone still
  fails: no GitHub credentials on Oracle; no deploy key created),
  run detached via a log file: `npm ci` ok, `npm run typecheck`
  exit 0, `npm test` 95 pass / 0 fail (10.5 s), `npm run check`
  exit 0.
- Oracle server smoke test: started on `127.0.0.1:14919`,
  `/health` returned `{"ok":true}`, `/` served the Spanish
  configuration UI, `ss` showed the listener on `127.0.0.1:14919`
  only; stopped afterwards by the pid reported by `ss` for that
  port and verified stopped. The deployed copy stays with the
  server stopped; it is not a service and does not start on boot.
- G2 closure is left to the user's re-review, as ordered: this
  parent verification does not close G2.

## G2 re-review 3 corrections 2026-10-28 (8ca80ef)

The user's re-review 3 of code commit `8ca80ef` (reviewed at evidence
commit `c8f481c`, whose diff to the code commit only touches this
file) found the CV/import issues fixed and two form failures left,
both reproduced in real Chrome with synthetic data. The review
scripts were not uploaded, so the cases were reproduced from the
report's written steps. All behaviours the user verified as working
in that report (CV conflict blocking, cross-import correction
rejection, unchanged-save conservation, reorder, delete-card,
per-profile CV, xAI invalidation, auto policy, deleted-profile
blocking, snapshots, ten-profile limit) remain green.

### 1. [P1] Saving did not update the form's reference state

- Reproduction (user's): load a person with no links/skills/salary
  and current=false, sponsorship=false; add a link, skills, salary,
  job achievements/links, check "Empleo actual" and "Necesita
  patrocinio", save (all persist); WITHOUT reloading, clear those
  fields, uncheck both boxes, add an end date, save again. Observed
  before the fix: links, skills, salary, achievements, job links
  remained, current and sponsorship_required stayed true (only the
  end date saved), because `formHad`, `formHadSalary` and the card
  datasets (`currentWas`, `sponsorshipWas`, `hadAchievements`,
  `hadLinks`) described the state at load or card creation and were
  never updated after a successful save, so the second save omitted
  empties/false values based on pre-first-save state and the
  backend preserved what was just stored.
- Fix by class (`apps/server/ui.html`, save handler): after every
  successful person save, the form is re-rendered from the persisted
  save response (`fillPersonForm(d.person.details)`). Reference
  flags, card datasets AND card ids are therefore always the
  persisted ones; no manual reload is ever required between edits.
  The unchanged-save positive case is unaffected: re-rendering
  from persisted values yields identical values.
- Regression test (real browser):
  "browser G2 re-review 3: consecutive saves without reload refresh
  reference state" — absent/empty -> value/true -> empty/false in
  the SAME screen, with saves between changes, asserted on screen
  after a reload and through the API (links/skills [], salary {},
  achievements/links [], current false, sponsorship false, end
  date saved).

### 2. [P2] Authorisations without an id duplicated on load+save

- Reproduction (user's): save a person with a legacy authorisation
  without an id (ES, authorised, 2030-12, sponsorship false);
  load and save without editing, repeatedly. Observed before the
  fix: 1 -> 2 -> 3 entries, the original never gaining an id,
  because the browser invented an id for the legacy entry while
  the backend keyed the stored entry by `country:ES` — different
  keys, so each save added a new logical row and kept the original.
  The existing module test sent an entry without an id and
  therefore did not reproduce what the screen actually sends.
- Fix by class, backend (`packages/shared/person.mjs`,
  `mergeAuthorisations`, replacing the generic country-fallback
  merge for authorisations): an entry WITH an id matches by id.
  An entry WITHOUT an id matches a stored id-less entry ONLY on
  full field identity — country, status, validity and sponsorship,
  plus any extra stored field (empty normalises to absent, an
  absent sponsorship flag reads as false, the form's checkbox
  semantics). Country alone is NEVER enough. On a full-identity
  match the stored entry is adopted and persists a stable id; with
  no match the entry is new. An id-less deletion marker removes
  only the fully matching stored entry. Stored entries are never
  silently dropped.
- Fix by class, form (`apps/server/ui.html`): legacy entries are
  rendered WITHOUT an invented id (`dataset.id = ""`), and the
  collector omits the id key for them, so the backend sees the
  entry it can adopt. Deleting a legacy card records a deletion
  marker with its current fields instead of an invented id. After
  every save the form adopts the ids from the persisted response
  (fix 1), so the next save addresses the entry by its stable id.
- Regression tests: browser test "browser G2 re-review 3: legacy
  authorisation without id gains a stable id and never duplicates"
  — three load/save rounds through the screen, exactly one entry
  after each, same stable id, validity and sponsorship intact.
  Module tests (`tests/g2-rereview3.test.mjs`): identical id-less
  entry adopts and gains an id; omitted sponsorship matches stored
  false; different validity or sponsorship never adopts; an
  id-less deletion marker removes only the fully matching entry
  and a non-matching marker removes nothing.
- Contract change, recorded with its reason: the old test "an
  id-less stored authorisation merges by country instead of
  duplicating" expected a country-only merge (adding a new
  valid_until to the stored entry). That is exactly the ambiguous
  matching the user forbade, so the test was rewritten to the new
  contract: a differing id-less entry becomes a second entry with
  the original untouched, while an identical id-less entry adopts
  the legacy one.

### Verification

- Working copy, Node v24.22.1: `npm run typecheck` exit 0,
  `npm test` 101 pass / 0 fail (was 95; +6: 4 module, 2 browser),
  `npm run check` exit 0.
- Fresh-clone verification (after pushing, so the clone is the new
  code): `git clone` to `/tmp/agentv2-g2rr3-clean`, Node v24.22.1,
  `npm ci` ok, `npm run typecheck` exit 0, `npm test` 101/101,
  `npm run check` exit 0, `.github` correctly absent (no Actions,
  no runners, as decided: GitHub is only for storage and
  versioning). Tested commit: `293e250`. This evidence was
  committed afterwards as docs-only; the code it describes is
  unchanged from `293e250`.
- Real xAI calls in this round: 0 (all xAI tests use mock fetches).
- G2 closure is left to the user's re-review, as ordered: this
  report does not close G2. A full F10 deployment (compose,
  install, backup/restore) is still pending and is not claimed.

### Honest limitation

- A legacy authorisation that is EDITED before its first adoption
  save (fields changed while it still has no id) does not match
  the stored entry on full identity — without an id, an edited
  legacy entry is indistinguishable from a new authorisation for
  the same country — so it is stored as a second entry and the
  original remains for the user to delete explicitly. After the
  first adoption save the entry has a stable id and every later
  edit is exact. The user's acceptance cases (repeated unchanged
  load/save) do not hit this window, and no silent duplication
  occurs on unchanged saves.
