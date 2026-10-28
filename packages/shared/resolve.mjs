// T-V2-019 / T-V2-020: Deterministic answer resolution by concept +
// scope. No LLM is involved and nothing is guessed silently:
//  - an exact confirmed declared fact (concept + scope) wins first;
//  - a fact declared without a scope, applied to a scoped question, is
//    an INFERENCE and is returned flagged with a warning, never as fact;
//  - when several confirmed facts share the concept but differ in scope
//    and the question names no scope, the answer is AMBIGUOUS and returns
//    the candidate options instead of picking one;
//  - when nothing is declared, the answer is MISSING and the screening
//    layer records the question exactly once as pending (see
//    resolveScreening). A supplied answer is stored as a declared fact,
//    so it is never asked again.
import { randomUUID } from "node:crypto";
import { factsForConcept, getConfirmedFact, declareFact } from "./facts.mjs";

// Fixed synonym dictionary (data, not inference): spelling variants of
// the same concept. Anything not listed here is a different concept.
const SYNONYMS = {
  work_authorization: "work_authorisation",
  authorized_to_work: "work_authorisation",
  authorised_to_work: "work_authorisation",
  salary_expectation: "salary_expectations",
  expected_salary: "salary_expectations",
  years_of_experience: "experience_years",
};

/** Normalize a concept: lower case, trim, collapse whitespace, synonyms. */
export function normalizeConcept(concept) {
  const base = String(concept).trim().toLowerCase().replace(/\s+/g, "_");
  return SYNONYMS[base] ?? base;
}

/**
 * Resolve one question deterministically.
 * @param {any} db
 * @param {string} personId
 * @param {{concept: string, scope?: string, questionText?: string}} question
 * @returns {Record<string, any>}
 */
export function resolveAnswer(db, personId, { concept, scope = "", questionText = "" }) {
  const norm = normalizeConcept(concept);
  const exact = getConfirmedFact(db, personId, norm, scope);
  if (exact) return { kind: "declared", concept: norm, scope, value: exact.value };
  const all = factsForConcept(db, personId, norm);
  if (all.length === 0) {
    return { kind: "missing", concept: norm, scope };
  }
  if (scope === "") {
    if (all.length === 1) return { kind: "declared", concept: norm, scope: all[0].scope, value: all[0].value };
    return {
      kind: "ambiguous", concept: norm, scope,
      warning: "several declared values share this concept with different scopes; the user must choose one",
      candidates: all.map((f) => ({ scope: f.scope, value: f.value })),
    };
  }
  const unscoped = all.find((f) => f.scope === "");
  if (unscoped) {
    return {
      kind: "inference", concept: norm, scope, value: unscoped.value,
      warning: "declared without a scope and applied to this scope as an inference, not as a declared fact",
    };
  }
  return {
    kind: "ambiguous", concept: norm, scope,
    warning: "declared values exist for other scopes only; none matches this scope",
    candidates: all.map((f) => ({ scope: f.scope, value: f.value })),
  };
}

/**
 * Resolve a batch of screening questions. Missing answers create a
 * pending question exactly once (the partial unique index on pending
 * questions plus this upsert make repeats idempotent).
 * @param {any} db
 * @param {string} personId
 * @param {Array<{concept: string, scope?: string, questionText?: string}>} questions
 * @returns {Array<Record<string, any>>}
 */
export function resolveScreening(db, personId, questions) {
  return questions.map((q) => {
    const answer = resolveAnswer(db, personId, q);
    if (answer.kind === "missing") {
      const text = q.questionText ?? `Please declare: ${answer.concept}${answer.scope ? ` (${answer.scope})` : ""}`;
      const existing = db.prepare("SELECT * FROM pending_questions WHERE person_id = ? AND concept = ? AND scope = ? AND status = 'pending'").get(personId, answer.concept, answer.scope);
      if (existing) return { ...answer, questionText: text, pendingQuestionId: existing.id };
      const id = randomUUID();
      db.prepare("INSERT INTO pending_questions (id, person_id, concept, scope, question_text) VALUES (?, ?, ?, ?, ?)").run(id, personId, answer.concept, answer.scope, text);
      return { ...answer, questionText: text, pendingQuestionId: id };
    }
    return answer;
  });
}

/**
 * Answer a pending question once and store the answer as a declared
 * fact, so the same question is never asked again.
 */
export function answerPendingQuestion(db, questionId, value, provenance = "user") {
  const q = db.prepare("SELECT * FROM pending_questions WHERE id = ?").get(questionId);
  if (!q) throw new Error("pending question not found");
  if (q.status !== "pending") throw new Error("pending question already answered");
  const factId = declareFact(db, { personId: q.person_id, concept: q.concept, scope: q.scope, value, provenance });
  db.prepare("UPDATE pending_questions SET status = 'answered', answered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(questionId);
  return factId;
}

export function listPendingQuestions(db, personId) {
  return db.prepare("SELECT * FROM pending_questions WHERE person_id = ? ORDER BY created_at ASC").all(personId);
}
