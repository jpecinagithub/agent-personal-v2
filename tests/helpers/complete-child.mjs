// Helper for the concurrent-complete race test: try to complete one job
// with the given token and print the outcome. Always exits 0 so the
// parent can compare both children's outcomes.
import { openDatabase } from "../../packages/shared/db.mjs";
import { complete } from "../../packages/shared/queue.mjs";

const [, , dbPath, jobId, token] = process.argv;
try {
  const db = openDatabase(dbPath);
  complete(db, jobId, token, { ok: true });
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: err.message }));
}
