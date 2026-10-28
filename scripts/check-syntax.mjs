// Portable syntax check (replaces the old Unix-only shell loop):
// walks apps/ and packages/ for *.mjs files and runs `node --check`
// on each. Syntax only — this is NOT the typecheck gate (that is
// `npm run typecheck`). Uses only Node stdlib, so it runs unchanged
// on Linux, macOS and Windows.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(p, out);
    } else if (entry.isFile() && p.endsWith(".mjs")) {
      out.push(p);
    }
  }
}

const files = [];
for (const sub of ["apps", "packages"]) walk(path.join(root, sub), files);
files.sort();
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(file);
    process.stderr.write((result.stderr || result.stdout || `syntax check failed: ${file}\n`).trimEnd() + "\n");
  }
}
if (failures.length > 0) {
  process.stderr.write(`check failed: ${failures.length} file(s) with syntax errors\n`);
  process.exit(1);
}
console.log(`check ok: ${files.length} files`);
