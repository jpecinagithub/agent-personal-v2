// F5 T-V2-041, T-V2-042, T-V2-043, T-V2-048: semantic resolution over
// the retained set. Synthetic fixtures only; no network, no LLM.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { createProfileFull } from "../packages/shared/profiles.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import { declareFact, listFacts } from "../packages/shared/facts.mjs";
import { listPendingQuestions } from "../packages/shared/resolve.mjs";
import {
  parseQuestionText, resolveSemantic, recordAlias, listAliases,
  promoteNarrativeToFact, assertNotNarrative, formatDateRange,
  formatDateAtPrecision, resolveHistoryEntry, fillHistorySlots,
  evaluateSemantic, auditResolvedAnswers,
} from "../packages/shared/semantic.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-semantic-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, FIXTURE_PERSON);
  const profileId = createProfileFull(db, personId, "Finance", {
    desired_roles: ["Finance Manager"], skills: ["SAP", "Excel"], locations: ["Logroño, Spain"],
  });
  return { db, personId, profileId };
}

const pendingCount = (db, personId) =>
  db.prepare("SELECT COUNT(*) AS n FROM pending_questions WHERE person_id = ? AND status = 'pending'").get(personId).n;

test("T-V2-041: question parsing identifies concept, negation and scope", () => {
  assert.deepEqual(parseQuestionText("Are you authorized to work in Spain?").concept, "work_authorisation");
  assert.equal(parseQuestionText("Are you authorized to work in Spain?").scope, "ES");
  assert.equal(parseQuestionText("Are you authorized to work in Spain?").negated, false);
  assert.equal(parseQuestionText("Are you NOT authorized to work in Spain?").negated, true);
  assert.equal(parseQuestionText("What is the weather today?").concept, null);
});

test("T-V2-041: one declaration resolves new paraphrase variants without another literal question", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const first = resolveSemantic(db, personId, { text: "Are you authorized to work in Spain?" });
  assert.equal(first.kind, "declared");
  assert.equal(first.value, "yes");
  assert.equal(pendingCount(db, personId), 0);
  const variant = resolveSemantic(db, personId, { text: "Are you authorised to work in ES?" });
  assert.equal(variant.kind, "declared");
  assert.equal(variant.value, "yes");
  assert.equal(pendingCount(db, personId), 0, "a paraphrase variant must not create a human question");
  const repeated = resolveSemantic(db, personId, { text: "Are you authorised to work in ES?" });
  assert.equal(repeated.origin, "alias", "a repeated variant resolves from its verified alias");
  assert.equal(pendingCount(db, personId), 0);
  assert.ok(listAliases(db, personId).length >= 1);
});

test("T-V2-041: opposite questions never merge by shared words", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const positive = resolveSemantic(db, personId, { text: "Are you authorized to work in Spain?" });
  const negative = resolveSemantic(db, personId, { text: "Are you not authorized to work in Spain?" });
  assert.equal(positive.value, "yes");
  assert.equal(negative.value, "no", "a negated variant flips the yes/no answer");
  assert.equal(negative.kind, "declared");
  const aliases = listAliases(db, personId);
  assert.ok(aliases.some((a) => a.negated === false));
  assert.ok(aliases.some((a) => a.negated === true));
});

test("T-V2-041: ambiguous scopes return candidates, never a silent pick", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  declareFact(db, { personId, concept: "work_authorisation", scope: "FR", value: "no", provenance: "user" });
  const ans = resolveSemantic(db, personId, { text: "Are you authorized to work?" });
  assert.equal(ans.kind, "ambiguous");
  assert.equal(ans.candidates.length, 2);
});

test("T-V2-042: conditional questions follow their explicit premise only", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  const premise = { concept: "work_authorisation", scope: "ES", expected: "yes" };
  const met = resolveSemantic(db, personId, { text: "Are you authorized to work in Spain?", premise });
  assert.equal(met.kind, "declared");
  const unmet = resolveSemantic(db, personId, {
    text: "Are you authorized to work in Spain?",
    premise: { concept: "work_authorisation", scope: "ES", expected: "no" },
  });
  assert.equal(unmet.kind, "not_applicable");
  const missing = resolveSemantic(db, personId, {
    text: "What is your salary?",
    premise: { concept: "sponsorship_required", scope: "ES", expected: "yes" },
  });
  assert.equal(missing.kind, "needs_premise", "a missing premise is asked, not bypassed");
  // Answering an unrelated concept must not satisfy the premise.
  declareFact(db, { personId, concept: "english_level", scope: "", value: "C1", provenance: "user" });
  const stillMissing = resolveSemantic(db, personId, {
    text: "What is your salary?",
    premise: { concept: "sponsorship_required", scope: "ES", expected: "yes" },
  });
  assert.equal(stillMissing.kind, "needs_premise");
});

test("T-V2-043: sensitive concepts are voluntary omissions without an explicit declaration", () => {
  const { db, personId } = setup();
  const omitted = resolveSemantic(db, personId, { text: "Do you have a criminal history?" });
  assert.equal(omitted.kind, "voluntary_omitted");
  assert.equal(pendingCount(db, personId), 0, "a voluntary question must not become a blocking question");
  declareFact(db, { personId, concept: "criminal_history", scope: "", value: "no", provenance: "user" });
  const declared = resolveSemantic(db, personId, { text: "Do you have a criminal history?" });
  assert.equal(declared.kind, "declared");
  assert.equal(declared.value, "no");
});

test("T-V2-043: aliases only after verified success; narrative and errors never contaminate", () => {
  const { db, personId } = setup();
  const missing = resolveSemantic(db, personId, { text: "Are you authorized to work in Spain?" });
  assert.equal(missing.kind, "missing");
  assert.equal(listAliases(db, personId).length, 0, "a failed resolution stores no alias");
  assert.throws(() => promoteNarrativeToFact(), /cannot be promoted/);
  assert.throws(() => assertNotNarrative({ provenance: "llm_output" }), /never facts/);
  assert.throws(
    () => recordAlias(db, personId, { variantText: "Are you authorized?", concept: "work_authorisation", scope: "ES", evidenceFactId: "no-such-fact" }),
    /not a confirmed declared fact/,
  );
  assert.equal(listAliases(db, personId).length, 0);
  assert.equal(listFacts(db, personId).length, 0);
  assert.equal(pendingCount(db, personId), 1, "the missing question itself is the one human question");
});

test("T-V2-042: history anchors use stable ids and held date precision, never an invented day", () => {
  assert.equal(formatDateAtPrecision("2016"), "2016");
  assert.equal(formatDateAtPrecision("2020-01"), "January 2020");
  assert.equal(formatDateAtPrecision("2024-06-15"), "June 15, 2024");
  assert.equal(formatDateRange({ start: "2020-01", end: "2024-06" }), "January 2020 – June 2024");
  assert.equal(formatDateRange({ start: "2016", end: null }), "2016 – Present");
  const entries = FIXTURE_PERSON.employment;
  const linked = resolveHistoryEntry(entries, "job-1");
  assert.equal(linked.kind, "linked");
  assert.equal(linked.entry.employer, "Fixture Corp");
  assert.equal(resolveHistoryEntry(entries, "nope").kind, "missing");
  const filled = fillHistorySlots(entries, 3);
  assert.equal(filled.filled, 1);
  assert.ok(filled.impediment.includes("only 1 exist"), "more slots than entries is an impediment, never fabricated entries");
  assert.ok(!JSON.stringify(filled.slots).includes("job-2"), "no entry contaminates another slot");
});

test("T-V2-048: semantic evaluation across ATS paraphrases measures questions and proves zero contamination", () => {
  const { db, personId } = setup();
  declareFact(db, { personId, concept: "work_authorisation", scope: "ES", value: "yes", provenance: "user" });
  declareFact(db, { personId, concept: "salary_expectations", scope: "", value: "EUR 50000-70000 per year", provenance: "user" });
  const cases = [
    { text: "Are you authorized to work in Spain?" },
    { text: "Are you authorised to work in ES?" },
    { text: "Legally allowed to work in Spain?" },
    { text: "Are you authorized to work in Spain?" },
    { text: "Are you not authorized to work in Spain?" },
    { text: "What are your salary expectations?" },
    { text: "What salary do you expect?" },
    { text: "Do you have a criminal history?" },
    { text: "What is your favourite colour?" },
  ];
  const ev = evaluateSemantic(db, personId, cases);
  assert.equal(ev.contamination, 0, "no invented fact reaches an answer");
  assert.equal(ev.humanQuestionsCreated, 1, "only the unidentified concept creates a human question; variants do not");
  assert.ok(ev.viaAlias >= 1, "a repeated literal variant resolves via alias");
  assert.equal(ev.voluntaryOmitted, 1);
  const negated = ev.answers[4];
  assert.equal(negated.value, "no");
  const audit = auditResolvedAnswers(db, personId, ev.answers);
  assert.equal(audit.contamination, 0);
  assert.equal(listPendingQuestions(db, personId).filter((q) => q.status === "pending").length, 0);
});
