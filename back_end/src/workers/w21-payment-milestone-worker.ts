import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * W21 — Payment milestone warnings/escalations (e.g. outstanding at milestones).
 *
 * This repo slice wires the worker to be schedule-safe and observable via TraceEvent.
 */
export async function runPaymentMilestoneWorker(prisma: PrismaClient, input: { entryId?: string; milestone?: string; timerRecordId?: string }) {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } as any });
    }
    await tx.traceEvent.create({
      data: {
        eventType: "PAYMENT_MILESTONE.W21_FIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Entry",
        entityId: typeof input.entryId === "string" ? input.entryId : "UNKNOWN",
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: null,
        entryId: typeof input.entryId === "string" ? input.entryId : null,
        payload: { milestone: typeof input.milestone === "string" ? input.milestone : null },
        createdBy: "SYSTEM",
      },
    });
  });
  return { ok: true } as const;
}

