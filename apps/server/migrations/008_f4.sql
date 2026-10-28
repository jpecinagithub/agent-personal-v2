-- 008: F4 analysis, plan and limits (T-V2-035..040).
-- Additive only: no existing table is altered.
-- application_plans stores the versioned plan in force; plan_versions
-- is the append-only version history (version 1 is stored at creation,
-- so the initial plan is never a version without a record). A plan's
-- profile/person/offer are fixed at creation: versions change steps,
-- documents, contingencies and rationale only (enforced in code).
-- trace_id links one inspected offer through assessment, plan and
-- every execution (G4 end-to-end traceability).
-- plan_executions rows are dry-run observations only: no row here
-- represents a fill, a submission or an attempt.
-- plan_adaptations records proposals AND refusals: status "refused"
-- with refusal_reason means the adaptation was rejected (e.g. it
-- would have changed a policy or a fact) and changed nothing.
-- rejected_instructions records malicious instructions found in
-- untrusted content, with source and sanitised excerpt only — never
-- the full untrusted body, never a secret value.
-- fact_questions are missing-fact questions (purpose + scope); the
-- answer, when confirmed, lives in declared_facts via fact_id, never
-- as a duplicate question row.
-- application_comparisons fixes one chosen profile per person+offer
-- (UNIQUE person+offer): a second comparison with a different profile
-- is refused in code, and an attempt for the same person+offer blocks
-- recording entirely.
CREATE TABLE IF NOT EXISTS application_plans (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  route_kind TEXT NOT NULL,
  ats TEXT NOT NULL DEFAULT 'unknown',
  tenant TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  rationale TEXT NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',
  documents_json TEXT NOT NULL DEFAULT '[]',
  contingencies_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft',
  trace_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS plan_versions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES application_plans(id),
  version INTEGER NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',
  documents_json TEXT NOT NULL DEFAULT '[]',
  rationale TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (plan_id, version)
);

CREATE TABLE IF NOT EXISTS plan_executions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES application_plans(id),
  plan_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  limits_json TEXT NOT NULL DEFAULT '{}',
  usage_json TEXT NOT NULL DEFAULT '{}',
  step_results_json TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL,
  trace_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS plan_adaptations (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES application_plans(id),
  execution_id TEXT,
  reason TEXT NOT NULL,
  changes_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'refused')),
  refusal_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS rejected_instructions (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('page', 'document', 'email')),
  source_ref TEXT,
  category TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS fact_questions (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  concept TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  question_text TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered')),
  fact_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  answered_at TEXT
);

CREATE TABLE IF NOT EXISTS application_comparisons (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  chosen_profile_id TEXT NOT NULL,
  assessments_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (person_id, offer_id)
);

CREATE INDEX IF NOT EXISTS idx_plans_person_offer ON application_plans (person_id, offer_id);
CREATE INDEX IF NOT EXISTS idx_plan_versions_plan ON plan_versions (plan_id, version);
CREATE INDEX IF NOT EXISTS idx_plan_executions_plan ON plan_executions (plan_id, created_at);
CREATE INDEX IF NOT EXISTS idx_rejected_source ON rejected_instructions (source_kind, created_at);
CREATE INDEX IF NOT EXISTS idx_fact_questions_person ON fact_questions (person_id, concept, scope, status);
