import type { PrismaClient } from "@prisma/client";
import { QuotationState } from "@prisma/client";

export async function runQuotationExpiryWorker(prisma: PrismaClient, input: { quotationId?: string; timerRecordId?: string }) {
  const now = new Date();
  const quotationId = typeof input.quotationId === "string" ? input.quotationId : undefined;
  if (!quotationId) return { skipped: true, reason: "MISSING_QUOTATION_ID" } as const;

  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) return { skipped: true, reason: "QUOTATION_NOT_FOUND" } as const;
  if (q.state !== QuotationState.SENT) return { skipped: true, reason: "NOT_SENT" } as const;

  if (q.validUntil && q.validUntil > now) {
    return { skipped: true, reason: "NOT_DUE" } as const;
  }

  await prisma.$transaction(async (tx) => {
    await tx.quotation.update({
      where: { id: quotationId },
      data: { state: QuotationState.EXPIRED, expiredAt: now },
    });

    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({
        where: { id: input.timerRecordId, status: "SCHEDULED" },
        data: { status: "FIRED", firedAt: now },
      });
    }

    // Cancel ack tracker timers if still scheduled.
    await tx.timerRecord.updateMany({
      where: {
        entityType: "Quotation",
        entityId: quotationId,
        status: "SCHEDULED",
        timerType: "QUOTATION_ACK_TRACKER",
      },
      data: { status: "CANCELLED", cancelledAt: now, cancelledBy: "SYSTEM", cancelledReason: "QUOTATION_EXPIRED" },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "S2.QUOTATION_EXPIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Quotation",
        entityId: quotationId,
        operation: "EXPIRE",
        timestamp: now,
        stageContext: "S2",
        inquiryId: null,
        entryId: q.entryId,
        payload: { quotationId, entryId: q.entryId, validUntil: q.validUntil?.toISOString() ?? null },
        createdBy: "SYSTEM",
      },
    });
  });

  return { skipped: false, quotationId } as const;
}

