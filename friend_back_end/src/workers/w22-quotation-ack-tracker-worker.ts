import type { PrismaClient } from "@prisma/client";

export async function runQuotationAckTrackerWorker(prisma: PrismaClient, input: { quotationId?: string; timerRecordId?: string }) {
  const now = new Date();
  const quotationId = typeof input.quotationId === "string" ? input.quotationId : undefined;
  if (!quotationId) return { skipped: true, reason: "MISSING_QUOTATION_ID" } as const;

  const q = await prisma.quotation.findUnique({ where: { id: quotationId } });
  if (!q) return { skipped: true, reason: "QUOTATION_NOT_FOUND" } as const;
  if (q.state === "ACCEPTED" || q.state === "EXPIRED" || q.state === "SUPERSEDED") {
    return { skipped: true, reason: "QUOTATION_RESOLVED" } as const;
  }

  await prisma.$transaction(async (tx) => {
    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({
        where: { id: input.timerRecordId, status: "SCHEDULED" },
        data: { status: "FIRED", firedAt: now },
      });
    }

    if (q.communicationRecordId) {
      const comm = await tx.communicationRecord.findUnique({ where: { id: q.communicationRecordId } });
      if (comm?.acknowledgementStatus === "RECEIVED") {
        await tx.traceEvent.create({
          data: {
            eventType: "S2.QUOTATION_ACK_WINDOW_SKIP",
            actorId: "SYSTEM",
            actorLevel: "SYSTEM",
            entityType: "Quotation",
            entityId: quotationId,
            operation: "SKIP",
            timestamp: now,
            stageContext: "S2",
            inquiryId: null,
            entryId: q.entryId,
            payload: { quotationId, entryId: q.entryId, communicationRecordId: q.communicationRecordId },
            createdBy: "SYSTEM",
          },
        });
        return;
      }
    }

    await tx.traceEvent.create({
      data: {
        eventType: "S2.QUOTATION_ACK_WINDOW_EXCEEDED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Quotation",
        entityId: quotationId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: "S2",
        inquiryId: null,
        entryId: q.entryId,
        payload: { quotationId, entryId: q.entryId, communicationRecordId: q.communicationRecordId ?? null },
        createdBy: "SYSTEM",
      },
    });
  });

  return { skipped: false, quotationId } as const;
}

