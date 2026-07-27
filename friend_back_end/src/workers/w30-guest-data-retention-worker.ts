import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * W30 (doc): Lost-found retention.
 * Code (current): registers `GUEST_DATA_RETENTION_P18` timer at S9 closure.
 *
 * This worker implements the *code path* (P18) as a pg-boss job so the timer is executable.
 */
export async function runGuestDataRetentionWorker(prisma: PrismaClient, input: { entryId?: string; timerRecordId?: string }) {
  const now = new Date();
  const entryId = typeof input.entryId === "string" ? input.entryId : null;
  await prisma.$transaction(async (tx) => {
    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } as any });
    }
    await tx.traceEvent.create({
      data: {
        eventType: "GUEST_DATA_RETENTION.P18_FIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Entry",
        entityId: entryId ?? "UNKNOWN",
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S9,
        inquiryId: null,
        entryId,
        payload: { entryId },
        createdBy: "SYSTEM",
      },
    });
  });
  return { ok: true } as const;
}

