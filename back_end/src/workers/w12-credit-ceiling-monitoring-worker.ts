import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * W12 — Credit ceiling monitoring notifications.
 *
 * Dispatched when a `CreditCeilingThresholdEvent` is written.
 */
export async function runCreditCeilingMonitoringWorker(
  prisma: PrismaClient,
  input: { entryId?: string; folioId?: string; thresholdPercent?: number; timerRecordId?: string },
) {
  const now = new Date();
  const entryId = typeof input.entryId === "string" ? input.entryId : null;

  await prisma.$transaction(async (tx) => {
    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } as any });
    }
    await tx.traceEvent.create({
      data: {
        eventType: "CREDIT_CEILING_THRESHOLD.W12_DISPATCHED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Entry",
        entityId: entryId ?? "UNKNOWN",
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: null,
        entryId,
        payload: {
          entryId,
          folioId: typeof input.folioId === "string" ? input.folioId : null,
          thresholdPercent: typeof input.thresholdPercent === "number" ? input.thresholdPercent : null,
        },
        createdBy: "SYSTEM",
      },
    });
  });

  return { skipped: entryId == null } as const;
}

