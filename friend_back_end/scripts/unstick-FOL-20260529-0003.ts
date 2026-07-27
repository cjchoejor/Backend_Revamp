import { PrismaClient, InventoryClaimState, HoldState } from "@prisma/client";

const prisma = new PrismaClient();
const folioId = "FOL-20260529-0003";
const ACTOR = "SYSTEM";
const REASON = "ManualFix: room/hold divergence from S6 room change (pre-fix flow)";

const folio = await prisma.folio.findUnique({
  where: { id: folioId },
  include: {
    entry: {
      include: {
        roomAssignments: { include: { room: true }, orderBy: { createdAt: "desc" }, take: 1 },
        committedHold: true,
      },
    },
  },
});
if (!folio?.entry) throw new Error(`Folio ${folioId} not found`);

const entry = folio.entry;
const latestAssignmentRoom = entry.roomAssignments[0]?.room;
if (!latestAssignmentRoom) throw new Error("No room assignment found");

const hold = entry.committedHold;
const oldRoomId = hold?.roomId && hold.roomId !== latestAssignmentRoom.id ? hold.roomId : null;
const oldRoom = oldRoomId ? await prisma.room.findUnique({ where: { id: oldRoomId } }) : null;

console.log("Before fix:", {
  latestRoom: { number: latestAssignmentRoom.roomNumber, claim: latestAssignmentRoom.currentClaimState },
  oldRoom: oldRoom ? { number: oldRoom.roomNumber, claim: oldRoom.currentClaimState } : null,
  hold: hold && { state: hold.state, roomId: hold.roomId },
});

await prisma.$transaction(async (tx) => {
  const now = new Date();

  // Release the stale committed hold (it points at the old room).
  if (hold && hold.state !== HoldState.RELEASED) {
    await tx.committedHold.update({
      where: { id: hold.id },
      data: { state: HoldState.RELEASED, releasedAt: now, releasedBy: ACTOR, releaseReason: REASON },
    });
  }

  // Free the stale old room (if it isn't already FREE).
  if (oldRoom && oldRoom.currentClaimState !== InventoryClaimState.FREE) {
    await tx.room.update({
      where: { id: oldRoom.id },
      data: { currentClaimState: InventoryClaimState.FREE, updatedAt: now },
    });
    await tx.roomClaimStateEvent.create({
      data: {
        roomId: oldRoom.id,
        entryId: entry.id,
        fromState: oldRoom.currentClaimState,
        toState: InventoryClaimState.FREE,
        actorId: ACTOR,
        reason: REASON,
        effectiveFrom: now,
      },
    });
  }

  // Mark the actually-assigned room as OCCUPIED so settlement can proceed.
  if (latestAssignmentRoom.currentClaimState !== InventoryClaimState.OCCUPIED) {
    await tx.room.update({
      where: { id: latestAssignmentRoom.id },
      data: { currentClaimState: InventoryClaimState.OCCUPIED, updatedAt: now },
    });
    await tx.roomClaimStateEvent.create({
      data: {
        roomId: latestAssignmentRoom.id,
        entryId: entry.id,
        fromState: latestAssignmentRoom.currentClaimState,
        toState: InventoryClaimState.OCCUPIED,
        actorId: ACTOR,
        reason: REASON,
        effectiveFrom: now,
      },
    });
  }

  // Audit trail entry so the fix shows up in the activity timeline.
  await tx.traceEvent.create({
    data: {
      eventType: "DATA_REPAIR.ROOM_HOLD_DIVERGENCE",
      actorId: ACTOR,
      actorLevel: "SYSTEM",
      entityType: "Entry",
      entityId: entry.id,
      operation: "ALERT",
      timestamp: now,
      stageContext: entry.currentStage,
      inquiryId: entry.inquiryId,
      entryId: entry.id,
      payload: {
        entryId: entry.id,
        folioId,
        repair: {
          freedRoom: oldRoom && oldRoom.currentClaimState !== InventoryClaimState.FREE ? oldRoom.roomNumber : null,
          occupiedRoom: latestAssignmentRoom.currentClaimState !== InventoryClaimState.OCCUPIED ? latestAssignmentRoom.roomNumber : null,
          releasedHoldId: hold?.id ?? null,
          reason: REASON,
        },
      },
      createdBy: ACTOR,
    },
  });
});

const after = await prisma.room.findMany({
  where: { id: { in: [latestAssignmentRoom.id, ...(oldRoom ? [oldRoom.id] : [])] } },
  select: { roomNumber: true, currentClaimState: true },
});
console.log("After fix:", after);
await prisma.$disconnect();
