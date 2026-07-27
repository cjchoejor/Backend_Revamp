import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * W27 — Dispute SLA monitoring (S7+).
 *
 * Emits an observable TraceEvent; timers are registered on dispute open (`schedule-dispute-sla-w27.ts`).
 */
export async function runDisputeSlaWorker(prisma: PrismaClient, input: { entryId?: string; disputeId?: string; timerRecordId?: string; phase?: string }) {
  const now = new Date();
  const entryId = typeof input.entryId === "string" ? input.entryId : null;
  const disputeId = typeof input.disputeId === "string" ? input.disputeId : "UNKNOWN";

  let stageContext: Stage = Stage.S8;
  if (entryId) {
    const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { currentStage: true } });
    if (entry?.currentStage) stageContext = entry.currentStage;
  }

  await prisma.$transaction(async (tx) => {
    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } as any });
    }
    await tx.traceEvent.create({
      data: {
        eventType: "DISPUTE_SLA.W27_CHECK",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "DisputeRecord",
        entityId: disputeId,
        operation: "ALERT",
        timestamp: now,
        stageContext,
        inquiryId: null,
        entryId,
        payload: {
          entryId,
          disputeId,
          phase: typeof input.phase === "string" ? input.phase : null,
        },
        createdBy: "SYSTEM",
      },
    });
  });
  return { ok: true } as const;
}
