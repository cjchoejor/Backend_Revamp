import type { PrismaClient } from "@prisma/client";
import { ProcessingLockStatus } from "@prisma/client";

export async function runProcessingLockExpiryWorker(prisma: PrismaClient, input: { lockId: string }) {
  const lock = await prisma.processingLockRecord.findUnique({ where: { id: input.lockId } });
  if (!lock) return { skipped: true, reason: "LOCK_NOT_FOUND" } as const;
  if (lock.status === ProcessingLockStatus.EXPIRED || lock.status === ProcessingLockStatus.RELEASED) {
    return { skipped: true, reason: "ALREADY_RESOLVED" } as const;
  }

  const expiredAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.processingLockRecord.update({
      where: { id: lock.id },
      data: { status: ProcessingLockStatus.EXPIRED, expiredAt },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "PROCESSING_LOCK.EXPIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "ProcessingLockRecord",
        entityId: lock.id,
        operation: "TRANSITION",
        timestamp: expiredAt,
        payload: {
          lockId: lock.id,
          actorId: lock.actorId,
          inventoryReference: lock.inventoryReference,
          channel: lock.channel,
          expiredAt: expiredAt.toISOString(),
        },
        entryId: lock.entryId ?? null,
        createdBy: "SYSTEM",
      },
    });
  });

  return { skipped: false } as const;
}

