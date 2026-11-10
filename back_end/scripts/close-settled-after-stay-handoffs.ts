/**
 * Close the after-stay handoffs left open on bills that already come to zero (2026-11-10). From now
 * on the system closes one itself whenever a bill's balance is worked out again (`after-stay-handoff.ts`,
 * called by `recomputeFolioOutstandingBalance`); a booking whose money was settled before that rule
 * still has its handoff open. This works the balance out again for each, which closes it by the same
 * rule. A bill still owing, or paid over, is listed and left open.
 *
 *   npx tsx scripts/close-settled-after-stay-handoffs.ts            # dry run
 *   npx tsx scripts/close-settled-after-stay-handoffs.ts --commit
 */
import { prisma } from "../src/db.js";
import { folioNetBalance, recomputeFolioOutstandingBalance } from "../src/lib/folio-outstanding-from-payment.js";

const COMMIT = process.argv.includes("--commit");
const open = await prisma.handoffRecord.findMany({
  where: { handoffType: "H5", state: { in: ["CREATED", "ACCEPTED", "ESCALATED"] }, entry: { currentStage: "S9", status: { not: "CLOSED" } } },
  select: { id: true, entryId: true, entry: { select: { folio: { select: { id: true } } } } },
});
let closing = 0;
for (const h of open) {
  const folioId = h.entry.folio?.id;
  if (!folioId) continue;
  const net = await folioNetBalance(prisma, folioId);
  const word = net.isZero() ? "nothing left to settle — closes" : net.gt(0) ? `Nu ${net.toFixed(2)} still owed — stays open` : `Nu ${net.abs().toFixed(2)} paid over — stays open until refunded`;
  console.log(`${h.entryId} ${h.id}: ${word}`);
  if (net.isZero()) {
    closing++;
    if (COMMIT) await prisma.$transaction((tx) => recomputeFolioOutstandingBalance(tx, folioId));
  }
}
console.log(`${open.length} open, ${closing} ${COMMIT ? "closed" : "would close"}${COMMIT ? "" : " (dry run — pass --commit)"}`);
process.exit(0);
