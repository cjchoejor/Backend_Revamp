import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * W27 — Dispute SLA monitoring (S8/S9).
 *
 * This repo slice emits an observable TraceEvent and can be extended to enforce
 * first-response + resolution SLAs, including escalation routing.
 */
export async function runDisputeSlaWorker(prisma: PrismaClient, input: { entryId?: string; disputeId?: string; timerRecordId?: string }) {
  const now = new Date();
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
        entityId: typeof input.disputeId === "string" ? input.disputeId : "UNKNOWN",
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S8,
        inquiryId: null,
        entryId: typeof input.entryId === "string" ? input.entryId : null,
        payload: { entryId: typeof input.entryId === "string" ? input.entryId : null, disputeId: typeof input.disputeId === "string" ? input.disputeId : null },
        createdBy: "SYSTEM",
      },
    });
  });
  return { ok: true } as const;
}

