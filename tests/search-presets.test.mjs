// F3 T-V2-023: search definitions, boolean AST, whole-word matching.
import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSearchDefinition, validateAst, evaluateAst, expandAst,
  wholeWordMatch, EXAMPLE_PRESETS,
} from "../packages/shared/search-presets.mjs";

function base(over = {}) {
  return {
    name: "Finance test",
    profileIds: ["profile-1"],
    titles: { any: ["Finance Manager"], exclude: ["Intern"] },
    locations: { countries: ["ES"], remoteCountries: ["ES"] },
    workModes: ["remote", "hybrid"],
    sources: ["greenhouse-catalog"],
    schedule: { timezone: "Europe/Madrid", localTimes: ["09:00"] },
    action: "save",
    limits: { maxJobs: 100, maxPagesPerSource: 10 },
    ...over,
  };
}

test("presets: a valid definition passes and unknown keys are rejected", () => {
  const def = validateSearchDefinition(base());
  assert.equal(def.name, "Finance test");
  assert.throws(() => validateSearchDefinition(base({ surprise: 1 })), /unknown search definition field/);
  assert.throws(() => validateSearchDefinition(base({ schedule: { timezone: "Europe/Madrid", localTimes: ["09:00"], extra: 1 } })), /unknown schedule field/);
  assert.throws(() => validateSearchDefinition(base({ limits: { maxJobs: 10, maxPagesPerSource: 10, extra: 1 } })), /unknown limits field/);
});

test("presets: required fields and enums are enforced", () => {
  assert.throws(() => validateSearchDefinition(base({ name: "  " })), /name is required/);
  assert.throws(() => validateSearchDefinition(base({ profileIds: [] })), /profileIds must be a non-empty array/);
  assert.throws(() => validateSearchDefinition(base({ profileIds: "profile-1" })), /profileIds must be a non-empty array/);
  assert.throws(() => validateSearchDefinition(base({ workModes: ["teleport"] })), /unknown workMode/);
  assert.throws(() => validateSearchDefinition(base({ action: "autoapply" })), /action must be one of/);
  assert.throws(() => validateSearchDefinition(base({ limits: { maxJobs: 0, maxPagesPerSource: 10 } })), /limits\.maxJobs must be a positive integer/);
  assert.throws(() => validateSearchDefinition(base({ schedule: { timezone: "Europe/Madrid", localTimes: ["9:00"] } })), /HH:MM/);
  assert.throws(() => validateSearchDefinition(base({ titles: { any: [] } })), /titles\.any must be a non-empty array/);
  const { titles, ...withoutTitles } = base();
  assert.throws(() => validateSearchDefinition(withoutTitles), /titles is required/);
});

test("presets: AST validation — phrases must be quoted, exclusions are not-nodes", () => {
  assert.throws(() => validateAst({ type: "phrase", value: "Financial Planning" }), /quoted string/);
  assert.doesNotThrow(() => validateAst({ type: "phrase", value: "\"Financial Planning\"" }));
  assert.throws(() => validateAst({ type: "term", value: "Finance Manager" }), /single unquoted word/);
  assert.throws(() => validateAst({ type: "and", children: [] }), /at least one child/);
  assert.throws(() => validateAst({ type: "not" }), /needs a child/);
  assert.throws(() => validateAst({ type: "xor", children: [] }), /unknown AST node type/);
  const ast = {
    type: "and",
    children: [
      { type: "or", children: [{ type: "term", value: "CFO" }, { type: "phrase", value: "\"Finance Director\"" }] },
      { type: "not", child: { type: "term", value: "Assistant" } },
      { type: "group", child: { type: "term", value: "Finance" } },
    ],
  };
  assert.doesNotThrow(() => validateAst(ast));
});

test("presets: synonyms only from an explicitly passed approved map — never invented", () => {
  const approved = { CFO: ["Chief Financial Officer"] };
  assert.throws(
    () => validateAst({ type: "term", value: "CFO", synonyms: ["Finance Boss"] }, approved),
    /not in approved map/,
  );
  assert.throws(
    () => validateAst({ type: "term", value: "CFO", synonyms: ["Chief Financial Officer"] }),
    /explicitly passed approved map/,
  );
  assert.doesNotThrow(
    () => validateAst({ type: "term", value: "CFO", synonyms: ["Chief Financial Officer"] }, approved),
  );
  const expanded = expandAst({ type: "term", value: "CFO" }, approved);
  assert.equal(expanded.type, "or");
  assert.deepEqual(expanded.children.map((c) => c.value), ["CFO", "Chief Financial Officer"]);
  // A term absent from the map is left unchanged, not expanded.
  assert.deepEqual(expandAst({ type: "term", value: "Controller" }, approved), { type: "term", value: "Controller" });
  assert.throws(() => expandAst({ type: "term", value: "CFO" }, null), /explicitly passed approved synonym map/);
});

test("presets: whole-word matching — Sales does NOT match Salesforce", () => {
  assert.equal(wholeWordMatch("Salesforce Administrator", "Sales"), false);
  assert.equal(wholeWordMatch("Sales Manager", "Sales"), true);
  assert.equal(wholeWordMatch("FINANCE manager", "finance"), true);
  assert.equal(wholeWordMatch("Finanzmanager", "Finance"), false);
  assert.equal(evaluateAst({ type: "term", value: "Sales" }, "Salesforce Administrator"), false);
  assert.equal(evaluateAst({ type: "phrase", value: "\"Financial Planning\"" }, "Head of Financial Planning and Analysis"), true);
  assert.equal(evaluateAst({ type: "phrase", value: "\"Financial Planning\"" }, "Financial PlanningAssistant"), false);
  const ast = {
    type: "and",
    children: [
      { type: "term", value: "Finance" },
      { type: "not", child: { type: "term", value: "Assistant" } },
    ],
  };
  assert.equal(evaluateAst(ast, "Finance Manager"), true);
  assert.equal(evaluateAst(ast, "Finance Assistant"), false);
  assert.equal(evaluateAst(ast, "Salesforce Administrator"), false);
});

test("presets: the three example presets are valid, editable examples with no invented personal data", () => {
  assert.equal(EXAMPLE_PRESETS.length, 3);
  assert.deepEqual(EXAMPLE_PRESETS.map((p) => p.name), [
    "Finance leadership (example)", "FP&A (example)", "Controlling (example)",
  ]);
  for (const preset of EXAMPLE_PRESETS) {
    assert.doesNotThrow(() => validateSearchDefinition(preset));
    // No countries, salaries or authorisations asserted by an example.
    assert.deepEqual(preset.locations.countries, []);
    assert.equal(preset.salary, undefined);
    assert.equal(preset.authorisationUnknown, undefined);
    assert.equal(preset.action, "save");
  }
  assert.ok(EXAMPLE_PRESETS[0].titles.any.includes("CFO"));
  assert.ok(EXAMPLE_PRESETS[1].titles.any.includes("FP&A Manager"));
  assert.ok(EXAMPLE_PRESETS[2].titles.any.includes("Financial Controller"));
});
