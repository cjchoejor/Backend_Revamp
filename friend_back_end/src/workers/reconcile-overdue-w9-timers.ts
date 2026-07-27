import type { PrismaClient } from "@prisma/client";
import { runPostCheckoutInspectionWorker } from "./w9-post-checkout-inspection-worker.js";

/**
 * After server downtime, pg-boss usually delivers overdue jobs on restart — this catches W9 timers
 * that are past due but still marked SCHEDULED (e.g. worker was off or job missed).
 */
export async function reconcileOverduePostCheckoutInspectionTimers(prisma: PrismaClient) {
  const now = new Date();
  const overdue = await prisma.timerRecord.findMany({
    where: {
      timerCode: "POST_CHECKOUT_INSPECTION_W9",
      status: "SCHEDULED",
      dueAt: { lte: now },
    },
    orderBy: { dueAt: "asc" },
    take: 50,
  });

  let fired = 0;
  for (const t of overdue) {
    const entryId = t.entryId;
    if (!entryId) continue;
    const result = await runPostCheckoutInspectionWorker(prisma, { entryId });
    if (!result.skipped) fired += 1;
  }
  return { checked: overdue.length, fired };
}
