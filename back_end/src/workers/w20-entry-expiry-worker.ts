import type { PrismaClient } from "@prisma/client";
import { EntryStatus } from "@prisma/client";

export async function runEntryExpiryWorker(prisma: PrismaClient, input: { entryId: string }) {
  const entry = await prisma.entry.findUnique({ where: { id: input.entryId } });
  if (!entry) return { skipped: true, reason: "ENTRY_NOT_FOUND" } as const;

  if (entry.status === EntryStatus.EXPIRED || entry.status === EntryStatus.CANCELLED || entry.status === EntryStatus.CLOSED) {
    return { skipped: true, reason: "ALREADY_TERMINAL" } as const;
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.entry.update({
      where: { id: entry.id },
      data: { status: EntryStatus.EXPIRED, closedAt: now, closedBy: "SYSTEM", version: { increment: 1 } },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.EXPIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Entry",
        entityId: entry.id,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: entry.currentStage,
        payload: { entryId: entry.id, fromStatus: entry.status, toStatus: "EXPIRED" },
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        createdBy: "SYSTEM",
      },
    });
  });

  return { skipped: false } as const;
}

