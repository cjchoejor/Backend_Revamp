import type { PrismaClient } from "@prisma/client";
import { findReplacedPapers } from "../lib/reply-waits.js";

export async function runAcknowledgementWindowWorker(prisma: PrismaClient, input: { communicationRecordId?: string; timerRecordId?: string }) {
  const now = new Date();
  const communicationRecordId = typeof input.communicationRecordId === "string" ? input.communicationRecordId : undefined;
  if (!communicationRecordId) return { skipped: true, reason: "MISSING_COMMUNICATION_RECORD_ID" } as const;

  const comm = await prisma.communicationRecord.findUnique({ where: { id: communicationRecordId } });
  if (!comm) return { skipped: true, reason: "COMM_NOT_FOUND" } as const;
  if (comm.acknowledgementStatus === "RECEIVED" || comm.acknowledgementStatus === "TIMED_OUT" || comm.acknowledgementStatus === "SUPERSEDED") {
    return { skipped: true, reason: "ALREADY_RESOLVED" } as const;
  }
  // A paper replaced since it was sent awaits no reply, so its window does not "time out" — it is
  // marked superseded instead (2026-10-13).
  if (comm.entryId && (await findReplacedPapers(prisma, comm.entryId, [comm])).length) {
    await prisma.communicationRecord.update({ where: { id: communicationRecordId }, data: { acknowledgementStatus: "SUPERSEDED" } });
    if (typeof input.timerRecordId === "string") {
      await prisma.timerRecord.updateMany({
        where: { id: input.timerRecordId, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: "SYSTEM", cancelledReason: "PAPER_REPLACED" },
      });
    }
    return { skipped: true, reason: "PAPER_REPLACED" } as const;
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

