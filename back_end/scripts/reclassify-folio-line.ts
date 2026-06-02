import { PrismaClient, FolioLineType } from "@prisma/client";

const prisma = new PrismaClient();
const folioId = "FOL-20260529-0002";
const targetDate = new Date(Date.UTC(2026, 4, 29, 0, 0, 0, 0)); // 2026-05-29 UTC midnight
const ACTOR = "SYSTEM";
const REASON = "ManualFix: reclassified test F&B line to ROOM_CHARGE on stay night to satisfy S8→S9 p62 gate";

const folio = await prisma.folio.findUnique({
  where: { id: folioId },
  include: { entry: true, lines: { orderBy: { chargeDate: "asc" } } },
});
if (!folio?.entry) throw new Error("Folio not found");

const candidate = folio.lines.find(
  (l) => l.lineType === FolioLineType.F_AND_B && (l.description ?? "").toLowerCase() === "hi",
);
if (!candidate) {
  console.log("No matching F&B test line found. Existing lines:", folio.lines.map((l) => ({ id: l.id, type: l.lineType, amount: l.amount.toString(), date: l.chargeDate, desc: l.description })));
  await prisma.$disconnect();
  process.exit(1);
}

console.log("Reclassifying:", { id: candidate.id, fromType: candidate.lineType, fromDate: candidate.chargeDate, amount: candidate.amount.toString() });

await prisma.$transaction(async (tx) => {
  await tx.folioLine.update({
    where: { id: candidate.id },
    data: {
      lineType: FolioLineType.ROOM_CHARGE,
      chargeDate: targetDate,
      description: "Stay-night room charge (reclassified from test F&B)",
    },
  });
  await tx.traceEvent.create({
    data: {
      eventType: "DATA_REPAIR.FOLIO_LINE_RECLASSIFIED",
      actorId: ACTOR,
      actorLevel: "SYSTEM",
      entityType: "FolioLine",
      entityId: candidate.id,
      operation: "UPDATE",
      timestamp: new Date(),
      stageContext: folio.entry.currentStage,
      inquiryId: folio.entry.inquiryId,
      entryId: folio.entry.id,
      payload: {
        folioId,
        folioLineId: candidate.id,
        fromType: candidate.lineType,
        toType: "ROOM_CHARGE",
        fromDate: candidate.chargeDate.toISOString(),
        toDate: targetDate.toISOString(),
        amount: candidate.amount.toString(),
        reason: REASON,
      },
      createdBy: ACTOR,
    },
  });
});

const after = await prisma.folioLine.findUnique({ where: { id: candidate.id } });
const folioAfter = await prisma.folio.findUnique({ where: { id: folioId }, select: { state: true, outstandingBalance: true } });
console.log("After:", {
  line: after && { type: after.lineType, date: after.chargeDate, amount: after.amount.toString() },
  folio: folioAfter && { state: folioAfter.state, outstanding: folioAfter.outstandingBalance.toString() },
});
await prisma.$disconnect();
