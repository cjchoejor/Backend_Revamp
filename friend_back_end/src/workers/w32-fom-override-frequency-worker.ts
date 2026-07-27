import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { runFomOverrideFrequencyWorker } from "./w33-fom-override-frequency-worker.js";

/**
 * Docs number this worker as W32. The existing implementation is in `w33-...` (historical numbering drift).
 * This wrapper provides the W32 file + exports used by the pg-boss runner.
 */
export async function runFomOverrideFrequencyWorkerW32(prisma: PrismaClient, input: { now?: Date } = {}) {
  const now = input.now ?? new Date();
  await prisma.$transaction(async (tx) => {
    if (typeof (input as any).timerRecordId === "string") {
      await tx.timerRecord.updateMany({
        where: { id: (input as any).timerRecordId, status: "SCHEDULED" },
        data: { status: "FIRED", firedAt: now } as any,
      });
    }
    await tx.traceEvent.create({
      data: {
        eventType: "FOM_OVERRIDE_FREQUENCY.W32_FIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "DisputeGateOverrideRecord",
        entityId: "W32",
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S8,
        inquiryId: null,
        entryId: null,
        payload: {},
        createdBy: "SYSTEM",
      },
    });
  });

  return runFomOverrideFrequencyWorker(prisma, { now });
}

