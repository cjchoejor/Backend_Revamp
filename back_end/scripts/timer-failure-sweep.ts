/**
 * The failed-timer sweep by hand (2026-10-26). Dry run by default: lists every timer job that
 * failed in the last week and not yet swept, and what the sweep would do with it.
 * `--commit` sends them again (it needs the queue, so it starts its own pg-boss connection).
 * The workers run the same sweep at start-up and every hour.
 */
import { prisma } from "../src/db.js";
import { createTimerEngine } from "../src/lib/timer-engine.js";
import { sweepFailedTimerJobs } from "../src/services/infrastructure/timer-failure-sweep-service.js";

const commit = process.argv.includes("--commit");

async function main() {
  let engine: ReturnType<typeof createTimerEngine> | null = null;
  if (commit) {
    engine = createTimerEngine(process.env.DATABASE_URL!);
    await engine.start();
  }
  const results = await sweepFailedTimerJobs(prisma, engine, { dryRun: !commit });
  if (!results.length) console.log("No failed timer job is waiting to be swept.");
  for (const r of results) {
    console.log(`${r.queue} ${r.jobId} → ${r.outcome} — ${r.reason}${r.entryId ? ` (${r.entryId})` : ""}${r.newJobId ? ` · new job ${r.newJobId}` : ""}`);
  }
  if (!commit && results.length) console.log("\nDry run — nothing written. Re-run with --commit to apply.");
  if (engine) await engine.stop();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
