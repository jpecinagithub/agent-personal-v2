// Pliego F3 T-V2-023 (RF-V2-021, RF-V2-022): saved-search definitions
// and the boolean expression tree (AST) they carry.
//
// A definition is validated, never silently repaired: unknown keys are
// rejected, required fields must be present, and synonym expansion
// happens ONLY from an explicitly passed approved map — this module
// never invents an expansion (03 §5: do not turn any finance role
// into CFO, do not expand beyond the approved equivalence catalogue).
//
// The three EXAMPLE_PRESETS below are the editable examples from
// 03 §3 (Finance leadership, FP&A, Controlling). They are examples
// only: they carry NO countries, salaries, authorisations or
// relocation preferences — those are configured during onboarding
// (03 §3). Their location lists are therefore intentionally empty:
// "no location configured yet", not "anywhere".

const ACTIONS = new Set(["save", "review", "auto"]);
const WORK_MODES = new Set(["remote", "hybrid", "onsite"]);

const ALLOWED_KEYS = new Set([
  "name", "profileIds", "titles", "locations", "workModes", "sources",
  "schedule", "action", "limits", "enabled", "offerLanguage", "salary",
  "sponsorshipUnknown", "relocationUnknown", "authorisationUnknown",
  "publishedWithinDays", "seniority", "contractTypes", "workingTime",
  "sectors", "companies", "skills", "excludedSkills", "descriptionTerms",
  "booleanAst",
]);

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim() !== "";
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((s) => isNonEmptyString(s));
}

function rejectUnknown(obj, allowed, where) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) throw new Error(`unknown ${where} field: ${key}`);
  }
}

function checkTime(value) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`schedule.localTimes entries must be HH:MM, got: ${value}`);
  }
}

/**
 * Validate a saved-search definition. Returns a normalised copy.
 * Throws on any violation; unknown keys are rejected at every level.
 * @param {any} def
 * @returns {any}
 */
export function validateSearchDefinition(def) {
  if (!def || typeof def !== "object" || Array.isArray(def)) {
    throw new Error("search definition must be an object");
  }
  rejectUnknown(def, ALLOWED_KEYS, "search definition");
  if (!isNonEmptyString(def.name)) throw new Error("search definition name is required");
  if (!Array.isArray(def.profileIds) || def.profileIds.length === 0 || !isStringArray(def.profileIds)) {
    throw new Error("profileIds must be a non-empty array of strings");
  }
  // Titles: a non-empty array, or { any: [...non-empty], exclude: [...] }.
  if (def.titles === undefined) throw new Error("titles is required");
  if (Array.isArray(def.titles)) {
    if (def.titles.length === 0 || !isStringArray(def.titles)) {
      throw new Error("titles must be a non-empty array of strings");
    }
  } else if (def.titles && typeof def.titles === "object") {
    rejectUnknown(def.titles, new Set(["any", "exclude"]), "titles");
    if (!Array.isArray(def.titles.any) || def.titles.any.length === 0 || !isStringArray(def.titles.any)) {
      throw new Error("titles.any must be a non-empty array of strings");
    }
    if (def.titles.exclude !== undefined && !isStringArray(def.titles.exclude)) {
      throw new Error("titles.exclude must be an array of strings");
    }
  } else {
    throw new Error("titles must be an array or an object with any/exclude");
  }
  // Locations: an object with country/region/city/remote lists (lists
  // may be empty — that means "not configured yet", never "worldwide"),
  // or a non-empty array of location strings.
  if (def.locations === undefined) throw new Error("locations is required");
  if (Array.isArray(def.locations)) {
    if (def.locations.length === 0 || !isStringArray(def.locations)) {
      throw new Error("locations must be a non-empty array of strings");
    }
  } else if (def.locations && typeof def.locations === "object") {
    rejectUnknown(def.locations, new Set(["countries", "regions", "cities", "remoteCountries"]), "locations");
    for (const k of ["countries", "regions", "cities", "remoteCountries"]) {
      if (def.locations[k] !== undefined && !isStringArray(def.locations[k])) {
        throw new Error(`locations.${k} must be an array of strings`);
      }
    }
  } else {
    throw new Error("locations must be an array or an object");
  }
  if (!Array.isArray(def.workModes) || def.workModes.length === 0 || !isStringArray(def.workModes)) {
    throw new Error("workModes must be a non-empty array of strings");
  }
  for (const m of def.workModes) {
    if (!WORK_MODES.has(m)) throw new Error(`unknown workMode: ${m}`);
  }
  if (!Array.isArray(def.sources) || def.sources.length === 0 || !isStringArray(def.sources)) {
    throw new Error("sources must be a non-empty array of strings");
  }
  if (!def.schedule || typeof def.schedule !== "object" || Array.isArray(def.schedule)) {
    throw new Error("schedule is required");
  }
  rejectUnknown(def.schedule, new Set(["timezone", "localTimes", "enabled"]), "schedule");
  if (!isNonEmptyString(def.schedule.timezone)) throw new Error("schedule.timezone is required");
  if (!Array.isArray(def.schedule.localTimes) || def.schedule.localTimes.length === 0
    || !def.schedule.localTimes.every((t) => typeof t === "string")) {
    throw new Error("schedule.localTimes must be a non-empty array of HH:MM strings");
  }
  for (const t of def.schedule.localTimes) checkTime(t);
  if (!ACTIONS.has(def.action)) throw new Error("action must be one of: save, review, auto");
  if (!def.limits || typeof def.limits !== "object" || Array.isArray(def.limits)) {
    throw new Error("limits is required");
  }
  rejectUnknown(def.limits, new Set(["maxJobs", "maxPagesPerSource"]), "limits");
  for (const k of ["maxJobs", "maxPagesPerSource"]) {
    if (!Number.isInteger(def.limits[k]) || def.limits[k] <= 0) {
      throw new Error(`limits.${k} must be a positive integer`);
    }
  }
  if (def.salary !== undefined && def.salary !== null) {
    if (typeof def.salary !== "object" || Array.isArray(def.salary)) throw new Error("salary must be an object");
    rejectUnknown(def.salary, new Set(["min", "max", "currency", "period", "unknownPolicy"]), "salary");
    if (def.salary.min !== undefined && def.salary.min !== null && typeof def.salary.min !== "number") {
      throw new Error("salary.min must be a number");
    }
    if (def.salary.max !== undefined && def.salary.max !== null && typeof def.salary.max !== "number") {
      throw new Error("salary.max must be a number");
    }
    if (def.salary.unknownPolicy !== undefined && !["review", "exclude", "include"].includes(def.salary.unknownPolicy)) {
      throw new Error("salary.unknownPolicy must be review, exclude or include");
    }
  }
  for (const k of ["sponsorshipUnknown", "relocationUnknown", "authorisationUnknown"]) {
    if (def[k] !== undefined && !["review", "exclude", "include"].includes(def[k])) {
      throw new Error(`${k} must be review, exclude or include`);
    }
  }
  if (def.publishedWithinDays !== undefined
    && (!Number.isInteger(def.publishedWithinDays) || def.publishedWithinDays <= 0)) {
    throw new Error("publishedWithinDays must be a positive integer");
  }
  if (def.booleanAst !== undefined) validateAst(def.booleanAst);
  return JSON.parse(JSON.stringify(def));
}

// ---------------------------------------------------------------- AST

const AST_TYPES = new Set(["term", "phrase", "and", "or", "not", "group"]);

/**
 * Validate a boolean AST.
 * - term: a single word (no whitespace, no quotes).
 * - phrase: a QUOTED string, e.g. `"Financial Planning"` — an
 *   unquoted phrase is rejected, so a phrase can never be mistaken
 *   for a loose bag of words.
 * - and/or: 1+ children; not/group: exactly one child.
 * - a node may carry `synonyms`, but only if every entry is in the
 *   explicitly passed approved map for that term (case-insensitive
 *   keys). Without an approved map, any synonyms list is rejected:
 *   expansions are never invented here.
 * @param {any} ast
 * @param {Record<string, string[]> | null} [approvedSynonyms]
 */
export function validateAst(ast, approvedSynonyms = null) {
  if (!ast || typeof ast !== "object" || Array.isArray(ast)) throw new Error("AST node must be an object");
  if (!AST_TYPES.has(ast.type)) throw new Error(`unknown AST node type: ${ast.type}`);
  if (ast.type === "term") {
    if (!isNonEmptyString(ast.value) || /\s/.test(ast.value) || ast.value.includes('"')) {
      throw new Error("term value must be a single unquoted word");
    }
  } else if (ast.type === "phrase") {
    if (!isNonEmptyString(ast.value) || ast.value.length < 3
      || !ast.value.startsWith('"') || !ast.value.endsWith('"')) {
      throw new Error("phrase value must be a quoted string, e.g. \"Financial Planning\"");
    }
  } else if (ast.type === "and" || ast.type === "or") {
    if (!Array.isArray(ast.children) || ast.children.length === 0) {
      throw new Error(`${ast.type} node needs at least one child`);
    }
    for (const child of ast.children) validateAst(child, approvedSynonyms);
  } else { // not, group
    if (!ast.child || typeof ast.child !== "object") throw new Error(`${ast.type} node needs a child`);
    validateAst(ast.child, approvedSynonyms);
  }
  if (ast.synonyms !== undefined) {
    if (!Array.isArray(ast.synonyms) || !ast.synonyms.every((s) => isNonEmptyString(s))) {
      throw new Error("synonyms must be an array of strings");
    }
    if (!approvedSynonyms) throw new Error("synonyms require an explicitly passed approved map");
    const approved = approvedSynonyms[ast.value] ?? approvedSynonyms[String(ast.value).toLowerCase()] ?? [];
    const allowed = new Set(approved.map((s) => s.toLowerCase()));
    for (const s of ast.synonyms) {
      if (!allowed.has(s.toLowerCase())) throw new Error(`synonym not in approved map: ${s}`);
    }
  }
  return ast;
}

/** Escape a string for use inside a RegExp. */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word, case-insensitive, unicode-aware match of `needle`
 * inside `text`. "Sales" does NOT match "Salesforce": both edges of
 * the needle must not be adjacent to a letter, number or underscore.
 * @param {string} text
 * @param {string} needle
 * @returns {boolean}
 */
export function wholeWordMatch(text, needle) {
  if (!text || !needle) return false;
  const pattern = `(?<![\\p{L}\\p{N}_])${escapeRegExp(needle)}(?![\\p{L}\\p{N}_])`;
  return new RegExp(pattern, "iu").test(text);
}

/**
 * Evaluate an AST against text. Terms match whole-word; phrases
 * match as a quoted multi-word span (whole-word at both edges);
 * not/group/and/or follow boolean semantics. Unknown/empty text
 * matches nothing except a top-level `not` of a non-match.
 * @param {any} ast
 * @param {string} text
 * @returns {boolean}
 */
export function evaluateAst(ast, text) {
  validateAst(ast);
  const haystack = typeof text === "string" ? text : "";
  switch (ast.type) {
    case "term":
      return wholeWordMatch(haystack, ast.value);
    case "phrase": {
      const inner = ast.value.slice(1, -1);
      return wholeWordMatch(haystack, inner);
    }
    case "and":
      return ast.children.every((c) => evaluateAst(c, haystack));
    case "or":
      return ast.children.some((c) => evaluateAst(c, haystack));
    case "not":
      return !evaluateAst(ast.child, haystack);
    case "group":
      return evaluateAst(ast.child, haystack);
    default:
      throw new Error(`unknown AST node type: ${ast.type}`);
  }
}

/**
 * Expand term nodes using ONLY the explicitly passed approved map
 * (term -> synonyms). A term absent from the map is left unchanged;
 * nothing is ever invented. Returns a new AST.
 * @param {any} ast
 * @param {Record<string, string[]>} approvedSynonyms
 * @returns {any}
 */
export function expandAst(ast, approvedSynonyms) {
  if (!approvedSynonyms || typeof approvedSynonyms !== "object") {
    throw new Error("expandAst requires an explicitly passed approved synonym map");
  }
  validateAst(ast);
  if (ast.type === "term") {
    const synonyms = approvedSynonyms[ast.value] ?? approvedSynonyms[String(ast.value).toLowerCase()] ?? [];
    if (synonyms.length === 0) return { type: "term", value: ast.value };
    return {
      type: "or",
      children: [{ type: "term", value: ast.value }, ...synonyms.map((s) => ({ type: "term", value: s }))],
    };
  }
  if (ast.type === "and" || ast.type === "or") {
    return { type: ast.type, children: ast.children.map((c) => expandAst(c, approvedSynonyms)) };
  }
  if (ast.type === "not" || ast.type === "group") {
    return { type: ast.type, child: expandAst(ast.child, approvedSynonyms) };
  }
  return { ...ast };
}

// ------------------------------------------------------- Example presets

const BASE_SCHEDULE = { timezone: "Europe/Madrid", localTimes: ["09:00"] };
const BASE_LIMITS = { maxJobs: 100, maxPagesPerSource: 10 };

/**
 * The three editable example presets from 03 §3. EXAMPLE data only:
 * no countries, salaries, authorisations or relocation preferences
 * are asserted here — locations are empty until onboarding configures
 * them. Each preset passes validateSearchDefinition as written.
 */
export const EXAMPLE_PRESETS = [
  validateSearchDefinition({
    name: "Finance leadership (example)",
    profileIds: ["profile-example"],
    titles: {
      any: ["CFO", "Finance Director", "Head of Finance"],
      exclude: ["Assistant", "Junior"],
    },
    locations: { countries: [], regions: [], cities: [], remoteCountries: [] },
    workModes: ["remote", "hybrid", "onsite"],
    sources: ["greenhouse-catalog", "lever-catalog", "ashby-catalog", "xai-web"],
    schedule: { ...BASE_SCHEDULE },
    action: "save",
    limits: { ...BASE_LIMITS },
    booleanAst: {
      type: "and",
      children: [
        {
          type: "or",
          children: [
            { type: "term", value: "CFO" },
            { type: "phrase", value: "\"Finance Director\"" },
            { type: "phrase", value: "\"Head of Finance\"" },
          ],
        },
        { type: "not", child: { type: "term", value: "Assistant" } },
        { type: "not", child: { type: "term", value: "Junior" } },
      ],
    },
  }),
  validateSearchDefinition({
    name: "FP&A (example)",
    profileIds: ["profile-example"],
    titles: {
      any: ["FP&A Manager", "Head of FP&A", "Financial Planning and Analysis"],
      exclude: ["Intern", "Junior"],
    },
    locations: { countries: [], regions: [], cities: [], remoteCountries: [] },
    workModes: ["remote", "hybrid", "onsite"],
    sources: ["greenhouse-catalog", "lever-catalog", "ashby-catalog", "xai-web"],
    schedule: { ...BASE_SCHEDULE },
    action: "save",
    limits: { ...BASE_LIMITS },
  }),
  validateSearchDefinition({
    name: "Controlling (example)",
    profileIds: ["profile-example"],
    titles: {
      any: ["Financial Controller", "Regional Controller", "Group Controller"],
      exclude: ["Intern", "Junior"],
    },
    locations: { countries: [], regions: [], cities: [], remoteCountries: [] },
    workModes: ["remote", "hybrid", "onsite"],
    sources: ["greenhouse-catalog", "lever-catalog", "ashby-catalog", "xai-web"],
    schedule: { ...BASE_SCHEDULE },
    action: "save",
    limits: { ...BASE_LIMITS },
  }),
];
