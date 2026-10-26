/**
 * The night audit's catch-up, by hand (2026-10-26). Dry run by default — lists every night in the
 * last week whose scheduled run is past and has no audit record, and what each run would post,
 * booking by booking. `--commit` runs them, oldest first, exactly as the workers do at start-up
 * and every hour (services/application/night-audit-catch-up-service.ts).
 *
 *   npx tsx scripts/night-audit-catch-up.ts            # dry run
 *   npx tsx scripts/night-audit-catch-up.ts --commit   # run the missed nights
 */
import { PrismaClient } from "@prisma/client";
import { catchUpMissedNightAudits } from "../src/services/application/night-audit-catch-up-service.js";

const prisma = new PrismaClient();
const COMMIT = process.argv.includes("--commit");

async function main() {
  const results = await catchUpMissedNightAudits(prisma, { dryRun: !COMMIT });
  if (!results.length) {
    console.log("No missed night: every night of the last week whose run is past has an audit record.");
    return;
  }
  for (const r of results) {
    console.log(`\n${r.night} · its run was due ${r.dueAt} · ${r.outcome}${r.runStatus ? ` (${r.runStatus})` : ""}${r.error ? ` — ${r.error}` : ""}`);
    for (const b of r.wouldPost ?? []) {
      const total = b.lines.reduce((s, l) => s + l.amount, 0);
      console.log(`   ${b.entryId}: ${b.lines.length} line(s), net ${total.toFixed(2)} before service charge and GST`);
      for (const l of b.lines) console.log(`      Room ${l.roomNumber} · ${l.description} · ${l.amount.toFixed(2)}`);
    }
    if (r.notProcessed?.length) console.log(`   not processed: ${r.notProcessed.join(", ")}`);
  }
  if (!COMMIT) console.log("\n(dry run — pass --commit to run these nights)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
