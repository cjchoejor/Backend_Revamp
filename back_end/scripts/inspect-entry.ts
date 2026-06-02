import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const entryId = process.argv[2] ?? "ENT-20260529-0002";

const entry = await prisma.entry.findUnique({
  where: { id: entryId },
  include: {
    reservation: true,
    folio: {
      include: {
        lines: { orderBy: { chargeDate: "asc" } },
        payments: { orderBy: { createdAt: "asc" } },
      },
    },
    roomAssignments: { include: { room: true }, orderBy: { createdAt: "desc" }, take: 1 },
  },
});

const amendments = await prisma.amendmentEventRecord.findMany({
  where: { entryId },
  orderBy: { createdAt: "asc" },
});
const audits = await prisma.nightAuditRecord.findMany({
  where: {},
  orderBy: { operatingDate: "asc" },
});

console.log(JSON.stringify({
  entry: entry && { id: entry.id, currentStage: entry.currentStage, segmentNumber: entry.segmentNumber, checkIn: entry.checkInDate, checkOut: entry.checkOutDate },
  reservation: entry?.reservation && {
    id: entry.reservation.id,
    frozenRate: entry.reservation.frozenRate.toString(),
    frozenCheckIn: entry.reservation.frozenCheckInDate,
    frozenCheckOut: entry.reservation.frozenCheckOutDate,
  },
  folio: entry?.folio && {
    id: entry.folio.id,
    state: entry.folio.state,
    billingModel: entry.folio.billingModel,
    outstandingBalance: entry.folio.outstandingBalance.toString(),
  },
  lines: entry?.folio?.lines.map((l) => ({ type: l.lineType, amount: l.amount.toString(), chargeDate: l.chargeDate, description: l.description })),
  payments: entry?.folio?.payments.map((p) => ({ amount: p.amount.toString(), direction: p.paymentDirection, at: p.receivedAt ?? p.createdAt, notes: p.notes })),
  room: entry?.roomAssignments[0]?.room && { number: entry.roomAssignments[0].room.roomNumber, claim: entry.roomAssignments[0].room.currentClaimState },
  amendments: amendments.map((a) => ({ type: a.amendmentType, reason: a.reason, stage: a.stageAtAmendment, createdAt: a.createdAt })),
  nightAudits: audits.length,
}, null, 2));

await prisma.$disconnect();
