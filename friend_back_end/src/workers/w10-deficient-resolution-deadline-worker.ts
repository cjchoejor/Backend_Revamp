import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * W10 — DEFICIENT resolution deadline monitoring.
 *
 * This repo slice records the breach as a TraceEvent and marks TimerRecord FIRED (if provided).
 */
export async function runDeficientResolutionDeadlineWorker(
  prisma: PrismaClient,
  input: { entryId?: string; roomId?: string; timerRecordId?: string },
) {
  const now = new Date();
  const entryId = typeof input.entryId === "string" ? input.entryId : null;
  const roomId = typeof input.roomId === "string" ? input.roomId : null;

  await prisma.$transaction(async (tx) => {
    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } as any });
    }
    await tx.traceEvent.create({
      data: {
        eventType: "DEFICIENT_RESOLUTION_DEADLINE.W10_FIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: roomId ? "Room" : "Entry",
        entityId: roomId ?? entryId ?? "UNKNOWN",
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: null,
        entryId,
        payload: { entryId, roomId },
        createdBy: "SYSTEM",
      },
    });
  });

  return { skipped: false, entryId, roomId } as const;
}

