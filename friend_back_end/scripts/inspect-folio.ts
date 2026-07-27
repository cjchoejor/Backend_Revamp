import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const folioId = process.argv[2] ?? "FOL-20260529-0003";
const folio = await prisma.folio.findUnique({
  where: { id: folioId },
  include: {
    entry: {
      include: {
        roomAssignments: { include: { room: true }, orderBy: { createdAt: "desc" }, take: 5 },
        reservation: true,
        committedHold: true,
      },
    },
  },
});
const entryId = folio?.entryId;
const claimEvents = entryId
  ? await prisma.roomClaimStateEvent.findMany({
      where: { entryId },
      include: { room: true },
      orderBy: { effectiveFrom: "asc" },
    })
  : [];
console.log(JSON.stringify({
  folio: folio && { id: folio.id, state: folio.state, billingModel: folio.billingModel },
  entry: folio?.entry && { id: folio.entry.id, currentStage: folio.entry.currentStage, segmentNumber: folio.entry.segmentNumber },
  committedHold: folio?.entry.committedHold && {
    state: folio.entry.committedHold.state,
    roomId: folio.entry.committedHold.roomId,
    placedAt: folio.entry.committedHold.placedAt,
    confirmedAt: folio.entry.committedHold.confirmedAt,
    releasedAt: folio.entry.committedHold.releasedAt,
    releaseReason: folio.entry.committedHold.releaseReason,
  },
  rooms: folio?.entry.roomAssignments.map((a) => ({ assignedAt: a.assignedAt, roomNumber: a.room.roomNumber, claim: a.room.currentClaimState })),
  claimTimeline: claimEvents.map((e) => ({ at: e.effectiveFrom, room: e.room.roomNumber, from: e.fromState, to: e.toState, reason: e.reason })),
}, null, 2));
await prisma.$disconnect();
