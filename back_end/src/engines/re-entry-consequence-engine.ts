import type { PrismaClient, Prisma } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * AC-S7-22: consequences must be computed before commit and executed in same tx.
 * In this repo slice, we model consequences as a TraceEvent marker.
 */
export async function computeReEntryConsequences(
  prisma: PrismaClient | Prisma.TransactionClient,
  input: { entryId: string; fromStage: Stage; toStage: Stage; reason: string; actorId: string },
) {
  const now = new Date();
  await (prisma as any).traceEvent.create({
    data: {
      eventType: "REENTRY.CONSEQUENCES_COMPUTED",
      actorId: input.actorId,
      actorLevel: "SYSTEM",
      entityType: "Entry",
      entityId: input.entryId,
      operation: "ALERT",
      timestamp: now,
      stageContext: input.fromStage,
      inquiryId: null,
      entryId: input.entryId,
      payload: { entryId: input.entryId, fromStage: input.fromStage, toStage: input.toStage, reason: input.reason },
      createdBy: input.actorId,
    },
  });
  return { ok: true, consequences: [] as Array<unknown> } as const;
}

