/**
 * Close the open pre-arrival tasks of bookings already at Arrival, as the system now does when
 * Arrival opens (2026-11-07, operator: "the prearrivals task be made done from backend for now and
 * not shown here in this stage"). Same rule as `completeTasksBySystem`: the night reminders are
 * registered, the pre-arrival message is not sent, and the money task closes (signing the advance
 * off) only when the advance is paid in full or none is asked.
 *
 *   npx tsx scripts/complete-pre-arrival-tasks.ts                 # dry run: what would close
 *   npx tsx scripts/complete-pre-arrival-tasks.ts --commit
 *   npx tsx scripts/complete-pre-arrival-tasks.ts --only ENT-… --commit
 */
import { prisma } from "../src/db.js";
import { evaluateAdvancePaymentCondition } from "../src/services/domain/s3-payment-service.js";
import { completeTasksBySystem } from "../src/services/domain/pre-arrival-service.js";

const args = process.argv.slice(2);
const commit = args.includes("--commit");
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

async function main() {
  const entries = await prisma.entry.findMany({
    where: {
      currentStage: "S5",
      status: { in: ["ACTIVE", "PARKED"] },
      preArrivalTasks: { some: { status: "PENDING" } },
      ...(only ? { id: only } : {}),
    },
    select: { id: true, folio: { select: { id: true } }, preArrivalTasks: { where: { status: "PENDING" }, select: { taskType: true } } },
    orderBy: { id: "asc" },
  });
  console.log(`${entries.length} booking(s) at Arrival with open pre-arrival tasks${commit ? "" : " (dry run — pass --commit to close them)"}`);
  for (const e of entries) {
    const paidInFull = e.folio
      ? (await evaluateAdvancePaymentCondition(prisma, { entryId: e.id, folioId: e.folio.id })).paidInFull === true
      : false;
    const types = e.preArrivalTasks.map((t) => t.taskType);
    const stays = types.includes("PAYMENT_RECONCILIATION") && !paidInFull ? " · the money task stays open (not paid in full)" : "";
    console.log(`  ${e.id}: ${types.join(", ")}${stays}`);
    if (commit) {
      const out = await completeTasksBySystem(prisma, e.id, "SYSTEM");
      console.log(`    closed ${out.completed.length}${out.leftOpen.length ? `, left open ${out.leftOpen.join(", ")}` : ""}`);
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  // Registering the night reminders starts the job queue, which would keep the script running.
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(process.exitCode ?? 0);
  });
