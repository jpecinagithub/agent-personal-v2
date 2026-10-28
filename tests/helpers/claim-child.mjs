// Helper for the restart-recovery test: claim one job and exit WITHOUT
// completing it, like a worker process killed mid-lease. Prints the token.
import { openDatabase } from "../../packages/shared/db.mjs";
import { claim } from "../../packages/shared/queue.mjs";

const db = openDatabase(process.argv[2]);
const job = claim(db, "child-worker", 60000);
console.log(JSON.stringify(job ? { id: job.id, token: job.lease_token } : null));
