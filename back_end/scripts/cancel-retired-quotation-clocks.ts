/**
 * Cancel the clocks still running on retired quotations (2026-10-07).
 *
 * Until `cancelQuotationClocksTx` (src/lib/quotation-clocks.ts), a quotation retired by a
 * configuration change at Negotiation, or by its validity running out, kept the answer window on
 * the email it went out in (W22) and its acknowledgement tracker. This cancels any such clock that
 * is still SCHEDULED: anchored on an EXPIRED or SUPERSEDED quotation, or on the email of one.
 *
 * Dry-run by default. Pass --commit to write.
 * Run from back_end/:  npx tsx scripts/cancel-retired-quotation-clocks.ts [--commit]
 */
import { prisma } from "../src/db.js";

const COMMIT = process.argv.includes("--commit");
const ACTOR = "actor-seed-system";

async function main() {
  const retired = await prisma.quotation.findMany({
    where: { state: { in: ["EXPIRED", "SUPERSEDED"] } },
    select: { id: true, entryId: true, communicationRecordId: true },
  });
  const quoteIds = retired.map((q) => q.id);
  const commIds = retired.map((q) => q.communicationRecordId).filter((x): x is string => !!x);
  const timers = quoteIds.length
    ? await prisma.timerRecord.findMany({
        where: {
          status: "SCHEDULED",
          OR: [
            { entityType: "Quotation", entityId: { in: quoteIds } },
            ...(commIds.length ? [{ entityType: "CommunicationRecord", entityId: { in: commIds } }] : []),
          ],
        },
        select: { id: true, entryId: true, timerCode: true, entityType: true, entityId: true, firesAt: true },
      })
    : [];

  console.log(`Retired quotations: ${retired.length} · clocks still running on them: ${timers.length}`);
  for (const t of timers) console.log(`  ${t.entryId} · ${t.timerCode} on ${t.entityType} ${t.entityId} · fires ${t.firesAt.toISOString()}`);
  if (timers.length === 0 || !COMMIT) {
    if (timers.length > 0) console.log("\nDry run — re-run with --commit to cancel the clocks above.");
    return;
  }
  // Row-level cancel: a pg-boss job that still fires no-ops on a CANCELLED TimerRecord.
  const res = await prisma.timerRecord.updateMany({
    where: { id: { in: timers.map((t) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: ACTOR, cancelledReason: "RETIRED_QUOTATION_CLOCK_CANCELLED" },
  });
  console.log(`\nCancelled ${res.count} clock${res.count === 1 ? "" : "s"}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
