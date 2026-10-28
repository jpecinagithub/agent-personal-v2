// F4 T-V2-039 (RF-V2-003, RF-V2-048): typed chat tools and
// missing-fact questions. Synthetic fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { createPersonFull } from "../packages/shared/person.mjs";
import { createProfileFull } from "../packages/shared/profiles.mjs";
import { listFacts } from "../packages/shared/facts.mjs";
import { getJob } from "../packages/shared/queue.mjs";
import { FIXTURE_PERSON } from "./fixtures.mjs";
import {
  executeChatTool, getSelectedProfile, askMissingFact, answerMissingFact, listFactQuestions,
} from "../packages/shared/chat-tools.mjs";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-chat-"));
  const db = openDatabase(path.join(dir, "agentv2.db"));
  const personId = createPersonFull(db, FIXTURE_PERSON);
  const profileId = createProfileFull(db, personId, "Finance", { focus: "Finance" });
  const otherPersonId = createPersonFull(db, { ...FIXTURE_PERSON, email: "other@example.test" });
  return { db, personId, profileId, otherPersonId };
}

test("T-V2-039: chat tools validate tool, schema and permissions BEFORE acting; a model phrase executes nothing", async () => {
  const { db, personId, profileId, otherPersonId } = setup();
  await assert.rejects(() => executeChatTool(db, "apply_to_everything", {}), /unknown chat tool/);
  await assert.rejects(() => executeChatTool(db, "choose_profile", { personId }), /requires argument: profileId/);
  await assert.rejects(() => executeChatTool(db, "choose_profile", { personId, profileId, extra: "x" }), /unknown argument/);
  await assert.rejects(() => executeChatTool(db, "choose_profile", { personId: otherPersonId, profileId }), /does not belong/);
  await assert.rejects(() => executeChatTool(db, "consult_results", {}), /requires runId or profileId/);
  await assert.rejects(() => executeChatTool(db, "pause_job", { jobId: "no-such-job" }), /only a pending or claimed job can be paused/);
  // Real results, not phrases: start/pause/cancel a job through the queue.
  const started = await executeChatTool(db, "start_job", { kind: "search", payload: { definitionId: "d1" } });
  assert.equal(getJob(db, started.result.jobId).status, "pending");
  const paused = await executeChatTool(db, "pause_job", { jobId: started.result.jobId });
  assert.equal(paused.result.status, "paused");
  assert.equal(getJob(db, started.result.jobId).status, "paused");
  const cancelled = await executeChatTool(db, "cancel_job", { jobId: started.result.jobId });
  assert.equal(cancelled.result.status, "cancelled");
  // Choose profile stores the selection; injected handlers return real results.
  const chosen = await executeChatTool(db, "choose_profile", { personId, profileId });
  assert.equal(chosen.result.selected, true);
  assert.equal(getSelectedProfile(db, personId), profileId);
  const analysed = await executeChatTool(db, "analyse_url", { url: "https://example.test/jobs/1" }, {
    analyseUrl: async (link) => ({ analysed: link }),
  });
  assert.equal(analysed.result.analysed, "https://example.test/jobs/1");
  const searched = await executeChatTool(db, "start_saved_search", { definitionId: "def-1" }, {
    runSearch: async (id) => ({ runId: "run-1", definitionId: id }),
  });
  assert.equal(searched.result.runId, "run-1");
});

test("T-V2-039: a missing fact produces ONE question with purpose + scope; a paraphrase reuses it; the answer is stored once as a concept", () => {
  const { db, personId } = setup();
  const first = askMissingFact(db, personId, {
    concept: "work_authorization", scope: "IE",
    questionText: "Are you authorised to work in Ireland?",
    purpose: "Needed to assess a mandatory offer requirement for Ireland.",
  });
  assert.equal(first.reused, false);
  assert.equal(first.question.purpose.includes("mandatory offer requirement"), true);
  assert.equal(first.question.scope, "IE");
  assert.equal(listFactQuestions(db, personId).length, 1);
  // Paraphrase, same normalised concept (synonym) + scope: reused, not duplicated.
  const paraphrase = askMissingFact(db, personId, {
    concept: "authorised_to_work", scope: "IE",
    questionText: "Do you have permission to work in Ireland, please?",
    purpose: "Needed to assess a mandatory offer requirement for Ireland.",
  });
  assert.equal(paraphrase.reused, true);
  assert.equal(paraphrase.kind, "pending_question");
  assert.equal(listFactQuestions(db, personId).length, 1, "a paraphrase never duplicates the question");
  // LLM/narrative provenance can never create the fact.
  assert.throws(() => answerMissingFact(db, first.question.id, "yes", "llm"), /cannot create a personal fact/);
  assert.equal(listFactQuestions(db, personId)[0].status, "pending", "the refused answer leaves the question pending");
  const factId = answerMissingFact(db, first.question.id, "yes", "user");
  assert.ok(factId);
  assert.equal(listFactQuestions(db, personId)[0].status, "answered");
  assert.equal(listFacts(db, personId).length, 1);
  assert.throws(() => answerMissingFact(db, first.question.id, "yes", "user"), /already answered/);
  // After answering, asking again reuses the stored fact.
  const again = askMissingFact(db, personId, {
    concept: "work_authorisation", scope: "IE",
    questionText: "Are you authorised to work in Ireland?",
    purpose: "Needed again.",
  });
  assert.equal(again.reused, true);
  assert.equal(again.kind, "fact");
  assert.equal(again.fact.value, "yes");
});
