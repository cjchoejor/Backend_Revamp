import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * W24 — Housekeeping SLA after checkout.
 *
 * This slice records the SLA breach as a TraceEvent and marks the TimerRecord FIRED (if timerRecordId provided).
 * Full escalation/notification logic can be layered on later.
 */
export async function runHousekeepingSlaWorker(prisma: PrismaClient, input: { entryId?: string; roomId?: string; timerRecordId?: string }) {
  const now = new Date();
  const roomId = typeof input.roomId === "string" ? input.roomId : undefined;
  if (!roomId) return { skipped: true, reason: "MISSING_ROOM_ID" } as const;

  const room = await prisma.room.findUnique({ where: { id: roomId } });
  if (!room) return { skipped: true, reason: "ROOM_NOT_FOUND" } as const;

  // Idempotency: if breach already recorded, skip.
  const existing = await prisma.traceEvent.findFirst({
    where: { entityType: "Room", entityId: roomId, eventType: "HOUSEKEEPING_SLA.BREACHED" },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return { skipped: true, reason: "IDEMPOTENT_TRACE_EXISTS" } as const;

  await prisma.$transaction(async (tx) => {
    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({
        where: { id: input.timerRecordId, status: "SCHEDULED" },
        data: { status: "FIRED", firedAt: now } as any,
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
          entryId: typeof input.entryId === "string" ? input.entryId : null,
          currentClaimState: (room as any).currentClaimState ?? null,
          physicalState: (room as any).physicalState ?? null,
        },
        createdBy: "SYSTEM",
      },
    });
  });

  return { skipped: false, roomId } as const;
}

