// F4 T-V2-039 (RF-V2-003, RF-V2-048): typed chat tools and
// missing-fact questions.
//
// A chat tool is a validated function call, not a model phrase: the
// tool name, the argument schema and the permission check are all
// enforced BEFORE anything acts, and the tool returns the real
// result of the underlying operation. Free text never executes and
// never accredits an action. Missing facts become QUESTIONS with a
// purpose and a scope; a confirmed answer is stored ONCE as a
// concept (via declareFact, which rejects LLM/narrative provenance),
// and a later equivalent paraphrase — same normalised concept and
// scope, different wording — reuses the stored answer or the pending
// question instead of asking again.

import { randomUUID } from "node:crypto";
import { normalizeConcept } from "./resolve.mjs";
import { declareFact, getConfirmedFact } from "./facts.mjs";
import { getProfileFull } from "./profiles.mjs";
import { enqueue, pauseJob, cancelJob, getJob } from "./queue.mjs";
import { listSearchResults } from "./search-run.mjs";

const TOOL_SCHEMAS = {
  start_saved_search: { required: ["definitionId"], optional: [] },
  analyse_url: { required: ["url"], optional: [] },
  choose_profile: { required: ["personId", "profileId"], optional: [] },
  start_job: { required: ["kind"], optional: ["payload"] },
  pause_job: { required: ["jobId"], optional: [] },
  cancel_job: { required: ["jobId"], optional: [] },
  consult_results: { required: [], optional: ["runId", "profileId"] },
};

function validateToolArgs(tool, args) {
  const schema = TOOL_SCHEMAS[tool];
  if (!schema) throw new Error(`unknown chat tool: ${tool}`);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("chat tool args must be an object");
  for (const key of Object.keys(args)) {
    if (!schema.required.includes(key) && !schema.optional.includes(key)) throw new Error(`unknown argument for ${tool}: ${key}`);
  }
  for (const key of schema.required) {
    if (args[key] === undefined || args[key] === null || args[key] === "") throw new Error(`chat tool ${tool} requires argument: ${key}`);
  }
  if (args.definitionId !== undefined && typeof args.definitionId !== "string") throw new Error("definitionId must be a string");
  if (args.url !== undefined && typeof args.url !== "string") throw new Error("url must be a string");
  if (args.personId !== undefined && typeof args.personId !== "string") throw new Error("personId must be a string");
  if (args.profileId !== undefined && typeof args.profileId !== "string") throw new Error("profileId must be a string");
  if (args.kind !== undefined && typeof args.kind !== "string") throw new Error("kind must be a string");
  if (args.jobId !== undefined && typeof args.jobId !== "string") throw new Error("jobId must be a string");
  return args;
}

/**
 * Execute one typed chat tool. Handlers are injected by the server
 * for operations that need the network (search runner, URL analysis);
 * everything else runs directly against the database. Nothing here
 * calls an LLM, and no tool creates an attempt or submits anything.
 * @param {any} db
 * @param {string} tool
 * @param {any} args
 * @param {{runSearch?: (definitionId: string) => Promise<any>, analyseUrl?: (url: string) => Promise<any>}} [handlers]
 */
export async function executeChatTool(db, tool, args, handlers = {}) {
  const valid = validateToolArgs(tool, args);
  switch (tool) {
    case "start_saved_search": {
      if (typeof handlers.runSearch !== "function") throw new Error("search runner is not available for this chat tool");
      const result = await handlers.runSearch(valid.definitionId);
      return { tool, result };
    }
    case "analyse_url": {
      if (typeof handlers.analyseUrl !== "function") throw new Error("URL analysis is not available for this chat tool");
      const result = await handlers.analyseUrl(valid.url);
      return { tool, result };
    }
    case "choose_profile": {
      const profile = getProfileFull(db, valid.profileId);
      if (!profile) throw new Error("profile not found");
      if (profile.person_id !== valid.personId) throw new Error("profile does not belong to this person");
      if (profile.deleted) throw new Error("profile is deleted");
      db.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(
        `selected_profile:${valid.personId}`, JSON.stringify(valid.profileId),
      );
      return { tool, result: { personId: valid.personId, profileId: valid.profileId, selected: true } };
    }
    case "start_job": {
      const id = enqueue(db, valid.kind, valid.payload ?? {});
      return { tool, result: { jobId: id, kind: valid.kind } };
    }
    case "pause_job": {
      pauseJob(db, valid.jobId);
      return { tool, result: { jobId: valid.jobId, status: "paused" } };
    }
    case "cancel_job": {
      cancelJob(db, valid.jobId);
      return { tool, result: { jobId: valid.jobId, status: "cancelled" } };
    }
    case "consult_results": {
      if (!valid.runId && !valid.profileId) throw new Error("consult_results requires runId or profileId");
      const results = listSearchResults(db, { runId: valid.runId ?? null, profileId: valid.profileId ?? null });
      return { tool, result: { results } };
    }
    default:
      throw new Error(`unknown chat tool: ${tool}`);
  }
}

/** The profile currently chosen via the chat tool, or null. */
export function getSelectedProfile(db, personId) {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`selected_profile:${personId}`);
  if (!row) return null;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}

/**
 * Ask a missing-fact question (concrete question + purpose + scope).
 * Reuse rules, in order: a confirmed fact for the normalised
 * concept+scope is returned (reused, no new question); an already
 * pending question for the same concept+scope is returned (a
 * paraphrase does not duplicate the question); otherwise one new
 * question row is created. Nothing here stores a fact.
 * @param {any} db
 */
export function askMissingFact(db, personId, { concept, scope = "", questionText, purpose }) {
  if (!personId) throw new Error("personId is required");
  if (typeof concept !== "string" || !concept.trim()) throw new Error("concept is required");
  if (typeof questionText !== "string" || !questionText.trim()) throw new Error("questionText is required");
  if (typeof purpose !== "string" || !purpose.trim()) throw new Error("purpose is required: a question must state why the fact is needed");
  const norm = normalizeConcept(concept);
  const existingFact = getConfirmedFact(db, personId, norm, scope);
  if (existingFact) return { reused: true, kind: "fact", fact: existingFact, question: null };
  const pending = db.prepare("SELECT * FROM fact_questions WHERE person_id = ? AND concept = ? AND scope = ? AND status = 'pending'").get(personId, norm, scope);
  if (pending) return { reused: true, kind: "pending_question", fact: null, question: pending };
  const id = randomUUID();
  db.prepare("INSERT INTO fact_questions (id, person_id, concept, scope, question_text, purpose, status) VALUES (?, ?, ?, ?, ?, ?, 'pending')").run(
    id, personId, norm, scope, questionText.trim(), purpose.trim(),
  );
  const question = db.prepare("SELECT * FROM fact_questions WHERE id = ?").get(id);
  return { reused: false, kind: "new_question", fact: null, question };
}

/**
 * Answer a pending missing-fact question: the answer is stored ONCE
 * as a declared concept via declareFact (which rejects LLM and
 * narrative provenance), and the question is marked answered. A
 * second answer to the same question is refused.
 * @param {any} db
 */
export function answerMissingFact(db, questionId, value, provenance = "user") {
  const q = db.prepare("SELECT * FROM fact_questions WHERE id = ?").get(questionId);
  if (!q) throw new Error("fact question not found");
  if (q.status !== "pending") throw new Error("fact question already answered");
  const factId = declareFact(db, { personId: q.person_id, concept: q.concept, scope: q.scope, value, provenance });
  db.prepare("UPDATE fact_questions SET status = 'answered', fact_id = ?, answered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(factId, questionId);
  return factId;
}

/** @param {any} db */
export function listFactQuestions(db, personId) {
  return db.prepare("SELECT * FROM fact_questions WHERE person_id = ? ORDER BY created_at ASC").all(personId);
}

/** The chat tool catalogue (names + required args), for the UI. */
export function chatToolCatalogue() {
  return Object.entries(TOOL_SCHEMAS).map(([tool, schema]) => ({ tool, required: schema.required, optional: schema.optional }));
}
