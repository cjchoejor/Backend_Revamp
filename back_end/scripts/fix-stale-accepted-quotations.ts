/**
 * One-off cleanup: retire ACCEPTED quotations left behind on SEALED segments.
 *
 * Backflows into S2 used to seal the old segment without touching its ACCEPTED quotation, so a
 * renegotiated booking ended up with several simultaneous "agreed prices". ENT-20260728-0014
 * accumulated three. Since `versionNumber` restarts at 1 per segment, readers that sorted by
 * version then picked an arbitrary older one — the invoice PDF printed a superseded segment's
 * price.
 *
 * The backflow now supersedes the outgoing accepted quote (see
 * lib/supersede-accepted-quotation-on-backflow.ts), and the two readers that sorted by version
 * were switched to createdAt. This script fixes rows created before those changes.
 *
 * Only touches quotations whose segment is SEALED and where a newer segment exists — i.e.
 * unambiguously historical. The newest segment's accepted quote is never touched.
 *
 * Dry run by default; --commit to write.
 */
import { QuotationState } from "@prisma/client";
import { prisma } from "../src/db.js";

const COMMIT = process.argv.includes("--commit");

async function main() {
  const entries = await prisma.entry.findMany({
    where: { quotations: { some: { state: QuotationState.ACCEPTED } } },
    select: {
      id: true,
      inquiryId: true,
      segments: { orderBy: { segmentNumber: "desc" }, select: { id: true, segmentNumber: true, sealedAt: true } },
      quotations: {
        where: { state: QuotationState.ACCEPTED },
        select: { id: true, segmentId: true, versionNumber: true, totalAmount: true, createdAt: true },
      },
    },
  });

  const toFix: Array<{ entryId: string; inquiryId: string | null; quotationId: string; segNo: number; amount: string }> = [];

  for (const e of entries) {
    const newest = e.segments[0];
    if (!newest) continue;
    // A booking that only ever moved forward has ONE segment, so its accepted quote is never
    // caught here. Extra segments are created by backflows (and by the legacy import, whose
    // entries carry no quotations) — so "accepted quote on a sealed, non-newest segment" means
    // a renegotiation superseded it. That is the discriminator, not the number of accepted
    // quotes: ENT-20260728-0011 has just one, stranded on a sealed segment, and is still stale.
    if (e.segments.length < 2) continue;
    const segNo = new Map(e.segments.map((s) => [s.id, s.segmentNumber]));
    const sealed = new Set(e.segments.filter((s) => s.sealedAt).map((s) => s.id));

    for (const q of e.quotations) {
      // Never touch the current segment's accepted quote — that one is the live agreement.
      if (q.segmentId === newest.id) continue;
      if (!sealed.has(q.segmentId)) continue; // unsealed non-current segment: leave for a human
      toFix.push({
        entryId: e.id,
        inquiryId: e.inquiryId,
        quotationId: q.id,
        segNo: segNo.get(q.segmentId) ?? -1,
        amount: q.totalAmount?.toString() ?? "?",
      });
    }
  }

  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — multi-segment entries with an ACCEPTED quotation: ${entries.filter((e) => e.segments.length > 1).length}`);
  console.log(`Stale ACCEPTED quotations on sealed segments: ${toFix.length}\n`);
  for (const f of toFix) {
    console.log(`   ${f.entryId}  ${f.quotationId}  seg#${f.segNo}  ${f.amount}  -> SUPERSEDED`);
  }

  if (toFix.length === 0) {
    console.log("\nNothing to do.");
    return;
  }
  if (!COMMIT) {
    console.log("\nDry run — nothing written. Re-run with --commit to apply.");
    return;
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    for (const f of toFix) {
      await tx.quotation.update({
        where: { id: f.quotationId },
        data: { state: QuotationState.SUPERSEDED, supersededAt: now },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "QUOTATION.SUPERSEDED_ON_BACKFLOW",
          actorId: "SYSTEM",
          actorLevel: "SYSTEM",
          entityType: "Quotation",
          entityId: f.quotationId,
          operation: "UPDATE",
          timestamp: now,
          entryId: f.entryId,
          inquiryId: f.inquiryId,
          payload: {
            quotationId: f.quotationId,
            segmentNumber: f.segNo,
            totalAmount: f.amount,
            reason: "BACKLOG_CLEANUP_STALE_ACCEPTED_ON_SEALED_SEGMENT",
            note: "Left ACCEPTED by a pre-2026-08-04 backflow that sealed the segment without retiring its quotation.",
          },
          createdBy: "SYSTEM",
        },
      });
    }
  });
  console.log(`\nSuperseded ${toFix.length} stale quotation(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
