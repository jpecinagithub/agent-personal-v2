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

Results: (filled below after the run; the tested commit is the code
commit, and this evidence file is committed afterwards as docs-only).
