import type { PrismaClient } from "@prisma/client";
import { InventoryClaimState, RoomPhysicalState, Stage } from "@prisma/client";

/**
 * W24 — the room's cleaning clock after a guest leaves it.
 *
 * Armed at check-out (and when one room of a party is released early), one clock per room, for
 * `housekeeping.sla.windowMinutes`. Housekeeping marking the room clean (`markRoomCleaned`) stops
 * it. When it fires on a room still waiting to be cleaned it writes `HOUSEKEEPING_SLA.BREACHED`,
 * which the desk reads as an overdue room.
 *
 * Fixed 2026-10-26: the breach was idempotent per ROOM for ever — once a room had one breach, every
 * later departure from it fired silently — and it fired on a room already cleaned. It is now
 * idempotent per clock, and a clock on a room that no longer needs cleaning is closed with no breach.
 */
export async function runHousekeepingSlaWorker(prisma: PrismaClient, input: { entryId?: string; roomId?: string; timerRecordId?: string }) {
  const now = new Date();
  const roomId = typeof input.roomId === "string" ? input.roomId : undefined;
  if (!roomId) return { skipped: true, reason: "MISSING_ROOM_ID" } as const;
  const timerRecordId = typeof input.timerRecordId === "string" ? input.timerRecordId : null;

  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) return { skipped: true, reason: "ROOM_NOT_FOUND" } as const;

  if (timerRecordId) {
    const timer = await prisma.timerRecord.findUnique({ where: { id: timerRecordId }, select: { status: true } });
    // Cancelled (the room was cleaned) or already handled — nothing to do.
    if (timer && timer.status !== "SCHEDULED") return { skipped: true, reason: `TIMER_${timer.status}` } as const;
    const already = await prisma.traceEvent.findFirst({
      where: {
        entityType: "Room",
        entityId: roomId,
        eventType: "HOUSEKEEPING_SLA.BREACHED",
        payload: { path: ["timerRecordId"], equals: timerRecordId },
      },
      select: { id: true },
    });
    if (already) return { skipped: true, reason: "IDEMPOTENT_TRACE_EXISTS" } as const;
  }

  const stillToClean =
    room.currentClaimState === InventoryClaimState.DEPARTED_DIRTY || room.physicalState === RoomPhysicalState.DIRTY;
  if (!stillToClean) {
    if (timerRecordId) {
      await prisma.timerRecord.updateMany({
        where: { id: timerRecordId, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: "SYSTEM", cancelledReason: "Room no longer waiting to be cleaned" },
      });
    }
    return { skipped: true, reason: "ROOM_NOT_WAITING_FOR_CLEANING" } as const;
  }

  await prisma.$transaction(async (tx) => {
    if (timerRecordId) {
      await tx.timerRecord.updateMany({
        where: { id: timerRecordId, status: "SCHEDULED" },
        data: { status: "FIRED", firedAt: now },
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "HOUSEKEEPING_SLA.BREACHED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Room",
        entityId: roomId,
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S8,
        inquiryId: null,
        entryId: typeof input.entryId === "string" ? input.entryId : null,
        payload: {
          roomId,
          roomNumber: room.roomNumber,
          timerRecordId,
          entryId: typeof input.entryId === "string" ? input.entryId : null,
          currentClaimState: room.currentClaimState,
          physicalState: room.physicalState,
        },
        createdBy: "SYSTEM",
      },
    });
  });

  return { skipped: false, roomId } as const;
}
