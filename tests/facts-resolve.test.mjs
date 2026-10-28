// T-V2-018 / T-V2-019 / T-V2-020: declared facts, deterministic
// resolution (declared / inference / ambiguous) and ask-once screening.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import { declareFact, listFacts } from "../packages/shared/facts.mjs";
import { resolveAnswer, resolveScreening, answerPendingQuestion, listPendingQuestions } from "../packages/shared/resolve.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-facts-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  return { db, personId: createPersonFull(db, FIXTURE_PERSON) };
}

test("narrative and LLM output are never stored as personal facts", () => {
  const { db, personId } = setup();
  for (const provenance of ["llm", "llm_output", "narrative", "inferred", "model-generated"]) {
    assert.throws(
      () => declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance }),
      /never facts/,
    );
  }
  assert.equal(listFacts(db, personId).length, 0);
});

test("a pending fact is listed but never resolves an answer", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user", confirmationState: "pending" });
  assert.equal(resolveAnswer(db, personId, { concept: "work_authorisation", scope: "ES" }).kind, "missing");
  assert.equal(listFacts(db, personId).length, 1);
});

test("same question set, three paths: declared wins, inference is flagged, ambiguity returns candidates", () => {
  const questions = [
    { concept: "work_authorisation", scope: "ES", questionText: "Are you authorised to work in ES?" },
    { concept: "work_authorisation", scope: "FR", questionText: "Are you authorised to work in FR?" },
    { concept: "salary_expectations", scope: "", questionText: "What are your salary expectations?" },
  ];
  // Person A: exact declared fact for ES.
  const a = setup();
  declareFact(a.db, { personId: a.personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const aAnswers = questions.map((q) => resolveAnswer(a.db, a.personId, q));
  assert.equal(aAnswers[0].kind, "declared");
  assert.equal(aAnswers[0].value, "yes");
  // Person B: only an unscoped fact; a scoped question is an inference, flagged.
  const b = setup();
  declareFact(b.db, { personId: b.personId, concept: "work_authorisation", scope: "", value: "yes", provenance: "user" });
  const bFr = resolveAnswer(b.db, b.personId, { concept: "work_authorisation", scope: "FR" });
  assert.equal(bFr.kind, "inference");
  assert.ok(bFr.warning.includes("inference"));
  // Person C: two scoped facts, unscoped question -> ambiguous candidates, no silent pick.
  const c = setup();
  declareFact(c.db, { personId: c.personId, concept: "salary_expectations", scope: "ES", value: 60000, provenance: "user" });
  declareFact(c.db, { personId: c.personId, concept: "salary_expectations", scope: "FR", value: 55000, provenance: "user" });
  const cAns = resolveAnswer(c.db, c.personId, { concept: "salary_expectations", scope: "" });
  assert.equal(cAns.kind, "ambiguous");
  assert.equal(cAns.candidates.length, 2);
  assert.ok(cAns.candidates.some((cand) => cand.scope === "ES" && cand.value === 60000));
  assert.ok(cAns.candidates.some((cand) => cand.scope === "FR" && cand.value === 55000));
});

test("a missing declaration is asked once, then stored and never asked again", () => {
  const { db, personId } = setup();
  const question = { concept: "work_authorisation", scope: "ES", questionText: "Are you authorised to work in ES?" };
  const first = resolveScreening(db, personId, [question]);
  assert.equal(first[0].kind, "missing");
  assert.ok(first[0].pendingQuestionId);
  const second = resolveScreening(db, personId, [question]);
  assert.equal(second[0].pendingQuestionId, first[0].pendingQuestionId, "the same pending question must be reused");
  assert.equal(listPendingQuestions(db, personId).filter((q) => q.status === "pending").length, 1);
  answerPendingQuestion(db, first[0].pendingQuestionId, "yes", "user");
  const third = resolveScreening(db, personId, [question]);
  assert.equal(third[0].kind, "declared");
  assert.equal(third[0].value, "yes");
  assert.equal(listPendingQuestions(db, personId).filter((q) => q.status === "pending").length, 0);
  assert.throws(() => answerPendingQuestion(db, first[0].pendingQuestionId, "no"), /already answered/);
});

test("concept synonyms resolve to the same declared fact", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const answer = resolveAnswer(db, personId, { concept: "authorized_to_work", scope: "ES" });
  assert.equal(answer.kind, "declared");
  assert.equal(answer.value, "yes");
});
