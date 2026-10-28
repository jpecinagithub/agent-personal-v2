// T-V2-014: xAI client (Node stdlib only, OpenAI-compatible chat completions).
// The API key comes only from the secret store or the environment, never
// from code. Remote model output is DATA, never a command: it is returned
// as text, it cannot change budgets, tools or permissions, and tool calls
// are only honoured when their name is on the caller's whitelist.
// The tool contract is complete in both directions: declared tools are
// sent as definitions in the request body, structured output is requested
// via response_format, and received tool-call arguments are parsed as JSON
// and validated against the declared parameters schema before being
// returned (as a parsed object, never as unvalidated text).
// Usage (tokens + cost ticks when present) is persisted per call, and a
// persisted budget limit refuses new calls once reached.
import { randomUUID } from "node:crypto";

export class XaiError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

export function classifyStatus(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  if (status === 400 || status === 422) return "validation";
  return "network";
}

// Minimal JSON-schema validation: object type, required keys, per-property
// primitive types, additionalProperties: false. Enough for the structured
// outputs this project uses; it is not a full JSON-schema engine.
export function validateSchema(value, schema) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new XaiError("validation", "structured output is not an object");
    for (const key of schema.required ?? []) {
      if (!(key in value)) throw new XaiError("validation", `structured output missing required key: ${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties ?? {}, key)) throw new XaiError("validation", `structured output has unexpected key: ${key}`);
      }
    }
    for (const [key, prop] of Object.entries(schema.properties ?? {})) {
      if (key in value && prop.type && typeof value[key] !== prop.type) throw new XaiError("validation", `structured output key ${key} has wrong type`);
    }
    return value;
  }
  throw new XaiError("validation", "unsupported schema type for structured output");
}

/**
 * Minimal fetch shape the client actually uses. Mock fetches in tests
 * return exactly this shape; the real global fetch is structurally
 * compatible with it (Response carries ok, status, text and json).
 * @typedef {(url: string, init?: object) => Promise<{ ok: boolean, status: number, text: () => Promise<string>, json: () => Promise<any> }>} FetchFn
 */

export class XaiClient {
  /**
   * @param {object} opts
   * @param {any} opts.db SQLite database (usage + budgets tables)
   * @param {string} [opts.model]
   * @param {FetchFn} [opts.fetchFn]
   * @param {any} [opts.secretStore]
   * @param {string | null} [opts.apiKey]
   */
  constructor({ db, model = "grok-4.20-non-reasoning", fetchFn = globalThis.fetch, secretStore = null, apiKey = null }) {
    this.db = db;
    this.model = model;
    this.fetchFn = fetchFn;
    this.apiKey = apiKey ?? process.env.XAI_API_KEY ?? (secretStore ? secretStore.get("xai_api_key") : undefined);
    if (!this.apiKey) throw new Error("xAI API key is not configured (secret store or XAI_API_KEY)");
    this.baseUrl = "https://api.x.ai/v1";
  }

  #budget() {
    return this.db.prepare("SELECT * FROM budgets WHERE id = 'xai'").get();
  }
  setBudget(limitTicks) {
    this.db.prepare("INSERT INTO budgets (id, limit_ticks) VALUES ('xai', ?) ON CONFLICT(id) DO UPDATE SET limit_ticks = excluded.limit_ticks").run(limitTicks);
  }
  usageTotals() {
    return this.db.prepare("SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens, COALESCE(SUM(completion_tokens), 0) AS completion_tokens, COALESCE(SUM(cost_ticks), 0) AS cost_ticks FROM usage_calls").get();
  }
  #checkBudget() {
    const budget = this.#budget();
    if (!budget) return;
    if (this.usageTotals().cost_ticks >= budget.limit_ticks) {
      throw new XaiError("budget", "persisted xAI budget limit reached; refusing new call");
    }
  }
  #recordUsage(usage) {
    this.db.prepare("INSERT INTO usage_calls (id, model, prompt_tokens, completion_tokens, cost_ticks) VALUES (?, ?, ?, ?, ?)").run(
      randomUUID(), this.model,
      usage?.prompt_tokens ?? 0, usage?.completion_tokens ?? 0, usage?.cost_in_usd_ticks ?? 0,
    );
  }

  // options: { prompt, schema?, allowedTools?, maxTokens? }
  // allowedTools is an array of tool definitions
  //   { name, description?, parameters? (JSON schema) }
  // or, for callers that only whitelist names, plain name strings.
  // Returns { text, parsed, toolCalls } where toolCalls contains ONLY
  // whitelisted tool names, with args as a PARSED object validated against
  // the declared parameters schema. A model reply that contains
  // instructions ("ignore limits...") is returned as plain text and
  // changes nothing.
  async complete({ prompt, schema = null, allowedTools = [], maxTokens = 200 }) {
    this.#checkBudget();
    // Normalise tool definitions once; the same definitions are sent in
    // the request and used to validate the reply, so the two sides of
    // the contract cannot drift apart.
    const toolDefs = allowedTools.map((t) => (typeof t === "string" ? { name: t } : t));
    for (const def of toolDefs) {
      if (!def || typeof def.name !== "string" || def.name.length === 0) {
        throw new XaiError("validation", "allowed tool definition must have a non-empty name");
      }
    }
    const requestBody = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
    };
    if (schema) {
      requestBody.response_format = {
        type: "json_schema",
        json_schema: { name: "structured_output", schema, strict: true },
      };
    }
    if (toolDefs.length > 0) {
      requestBody.tools = toolDefs.map((def) => ({
        type: "function",
        function: {
          name: def.name,
          description: def.description ?? "",
          parameters: def.parameters ?? { type: "object", properties: {} },
        },
      }));
    }
    let res;
    try {
      res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      throw new XaiError("network", `xAI request failed: ${err.message}`);
    }
    if (!res.ok) {
      let detail = "";
      try { detail = await res.text(); } catch { /* ignore */ }
      throw new XaiError(classifyStatus(res.status), `xAI HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const body = await res.json();
    const message = body.choices?.[0]?.message ?? {};
    const text = message.content ?? "";
    this.#recordUsage(body.usage);
    const rawToolCalls = message.tool_calls ?? [];
    const allowed = new Map(toolDefs.map((def) => [def.name, def]));
    const toolCalls = [];
    for (const call of rawToolCalls) {
      const name = call.function?.name;
      const def = allowed.get(name);
      if (!def) {
        throw new XaiError("validation", `model requested non-whitelisted tool: ${name}`);
      }
      let args;
      try {
        args = JSON.parse(call.function?.arguments ?? "{}");
      } catch {
        throw new XaiError("validation", `tool call arguments for ${name} are not valid JSON`);
      }
      if (def.parameters && def.parameters.type === "object") {
        try {
          validateSchema(args, def.parameters);
        } catch (err) {
          throw new XaiError("validation", `tool call arguments for ${name} failed schema validation: ${err.message}`);
        }
      }
      toolCalls.push({ name, args });
    }
    let parsed = null;
    if (schema) {
      let json;
      try { json = JSON.parse(text); } catch { throw new XaiError("validation", "structured output is not valid JSON"); }
      parsed = validateSchema(json, schema);
    }
    return { text, parsed, toolCalls };
  }
}
