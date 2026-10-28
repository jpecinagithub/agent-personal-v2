// T-V2-021: Field mappings are per-source only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../packages/shared/db.mjs";
import { defineMapping, getMapping, listMappings } from "../packages/shared/mappings.mjs";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentv2-map-"));
  return openDatabase(path.join(dir, "agentv2.db"));
}

test("a mapping defined for one source is never applied to another source", () => {
  const db = tmpDb();
  defineMapping(db, { source: "greenhouse", fieldKey: "work_authorisation", sourceField: "work_authorization" });
  defineMapping(db, { source: "lever", fieldKey: "work_authorisation", sourceField: "authorized_to_work" });
  assert.equal(getMapping(db, "greenhouse", "work_authorisation"), "work_authorization");
  assert.equal(getMapping(db, "lever", "work_authorisation"), "authorized_to_work");
  assert.equal(getMapping(db, "ashby", "work_authorisation"), null, "ashby has no mapping and must not inherit greenhouse's");
  assert.equal(getMapping(db, "GREENHOUSE", "work_authorisation"), "work_authorization", "source lookup is case-insensitive");
});

test("redefining a mapping updates only that source and key", () => {
  const db = tmpDb();
  defineMapping(db, { source: "greenhouse", fieldKey: "salary", sourceField: "salary_a" });
  defineMapping(db, { source: "greenhouse", fieldKey: "salary", sourceField: "salary_b" });
  defineMapping(db, { source: "ashby", fieldKey: "salary", sourceField: "salary_c" });
  assert.equal(getMapping(db, "greenhouse", "salary"), "salary_b");
  assert.equal(getMapping(db, "ashby", "salary"), "salary_c");
  assert.equal(listMappings(db, "greenhouse").length, 1);
  assert.throws(() => defineMapping(db, { source: "", fieldKey: "x", sourceField: "y" }), /source is required/);
});
