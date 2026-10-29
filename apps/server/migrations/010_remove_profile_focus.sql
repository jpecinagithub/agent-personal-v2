-- 010: user order 2026-10-29 — the profile "focus" (enfoque) field is
-- deleted entirely: the profile name alone identifies a profile, and
-- focus stops being a readiness requirement. The column drop and the
-- body_json cleanup are implemented in JavaScript
-- (packages/shared/remove-profile-focus.mjs, run from openDatabase),
-- because the drop must be conditional (databases created after this
-- change never have the column) and the JSON cleanup needs parsing.
-- This file exists so the migration is recorded in the version chain.
SELECT 1;
