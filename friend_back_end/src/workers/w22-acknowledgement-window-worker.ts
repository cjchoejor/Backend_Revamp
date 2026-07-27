import type { PrismaClient } from "@prisma/client";

export async function runAcknowledgementWindowWorker(prisma: PrismaClient, input: { communicationRecordId?: string; timerRecordId?: string }) {
  const now = new Date();
  const communicationRecordId = typeof input.communicationRecordId === "string" ? input.communicationRecordId : undefined;
  if (!communicationRecordId) return { skipped: true, reason: "MISSING_COMMUNICATION_RECORD_ID" } as const;

  const comm = await prisma.communicationRecord.findUnique({ where: { id: communicationRecordId } });
  if (!comm) return { skipped: true, reason: "COMM_NOT_FOUND" } as const;
  if (comm.acknowledgementStatus === "RECEIVED" || comm.acknowledgementStatus === "TIMED_OUT") {
    return { skipped: true, reason: "ALREADY_RESOLVED" } as const;
  }

  await prisma.$transaction(async (tx) => {
    await tx.communicationRecord.update({
      where: { id: communicationRecordId },
      data: { acknowledgementStatus: "TIMED_OUT" },
    });

    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({
        where: { id: input.timerRecordId, status: "SCHEDULED" },
        data: { status: "FIRED", firedAt: now },
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "ACKNOWLEDGEMENT.WINDOW_EXPIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "CommunicationRecord",
        entityId: communicationRecordId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: comm.stageContext ?? undefined,
        inquiryId: null,
        entryId: comm.entryId,
        payload: { communicationRecordId, entryId: comm.entryId, commType: comm.commType },
        createdBy: "SYSTEM",
      },
    });
  });

  return { skipped: false, communicationRecordId } as const;
}

