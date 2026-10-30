/**
 * Retire held papers that describe a pass the booking has left (2026-10-29).
 *
 * Since 2026-10-29 every re-entry retires the papers held for the desk (`retireHeldPapersOnReEntryTx`),
 * because a paper held for a sealed pass describes a stay that no longer stands — sending it would
 * mislead the guest. Papers held BEFORE that rule were left waiting: ENT-20261029-0001's pass-1
 * voucher still asked to be sent after "Change the dates" sent the booking back to Inquiry, and
 * ENT-20261014-0016's split-off voucher from 14 Oct sat on its Set up.
 *
 * A held paper is stale when:
 *   - a voucher's reservation is not the booking's current one, or its pass is sealed;
 *   - a proforma is superseded, or was made before the booking's current pass began.
 * Stale papers are marked SUPERSEDED (never sent), traced DOCUMENT.HELD_RETIRED.
 *
 *   npx tsx scripts/retire-stale-held-papers.ts            dry run
 *   npx tsx scripts/retire-stale-held-papers.ts --commit   apply
 */
import { prisma } from "../src/db.js";

const commit = process.argv.includes("--commit");

async function main() {
  const open = await prisma.heldDocument.findMany({ where: { decision: null }, orderBy: { heldAt: "asc" } });
  const stale: Array<{ id: string; entryId: string; kind: string; documentId: string; why: string }> = [];
  for (const h of open) {
    const entry = await prisma.entry.findUnique({
      where: { id: h.entryId },
      select: { id: true, currentReservationId: true, segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true, startedAt: true } } },
    });
    if (!entry) continue;
    const seg = entry.segments[0] ?? null;
    if (h.kind === "CONFIRMATION_VOUCHER") {
      const res = await prisma.reservation.findUnique({ where: { id: h.documentId }, select: { id: true, segmentId: true } });
      if (!res) stale.push({ id: h.id, entryId: h.entryId, kind: h.kind, documentId: h.documentId, why: "the reservation is gone" });
      else if (entry.currentReservationId !== res.id) stale.push({ id: h.id, entryId: h.entryId, kind: h.kind, documentId: h.documentId, why: "not the booking's current reservation" });
      else if (seg && res.segmentId !== seg.id) stale.push({ id: h.id, entryId: h.entryId, kind: h.kind, documentId: h.documentId, why: "made for an earlier pass" });
    } else {
      const inv = await prisma.invoice.findUnique({ where: { id: h.documentId }, select: { id: true, state: true, createdAt: true } });
      if (!inv) stale.push({ id: h.id, entryId: h.entryId, kind: h.kind, documentId: h.documentId, why: "the proforma is gone" });
      else if (inv.state === "SUPERSEDED") stale.push({ id: h.id, entryId: h.entryId, kind: h.kind, documentId: h.documentId, why: "the proforma was replaced" });
      else if (seg && inv.createdAt < seg.startedAt) stale.push({ id: h.id, entryId: h.entryId, kind: h.kind, documentId: h.documentId, why: "made for an earlier pass" });
    }
  }
  console.log(`${open.length} held paper(s) waiting · ${stale.length} stale`);
  for (const s of stale) console.log(`  ${s.entryId}  ${s.kind}  ${s.documentId}  — ${s.why}`);
  if (!commit) {
    console.log("\n(dry run — pass --commit to apply)");
    return;
  }
  const now = new Date();
  for (const s of stale) {
    await prisma.heldDocument.update({
      where: { id: s.id },
      data: { decision: "SUPERSEDED", decidedAt: now, decidedBy: "SYSTEM", note: `Retired — ${s.why}; the booking's current pass makes its own papers` },
    });
    await prisma.traceEvent.create({
      data: {
        eventType: "DOCUMENT.HELD_RETIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM" as never,
        entityType: "HeldDocument",
        entityId: s.id,
        operation: "UPDATE",
        timestamp: now,
        entryId: s.entryId,
        payload: { heldDocumentId: s.id, kind: s.kind, documentId: s.documentId, why: s.why, via: "retire-stale-held-papers" },
        createdBy: "SYSTEM",
      },
    });
  }
  console.log(`\nRetired ${stale.length}.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
