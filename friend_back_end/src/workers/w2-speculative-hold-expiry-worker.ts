import type { PrismaClient } from "@prisma/client";
import { HoldState, InventoryClaimState, Stage } from "@prisma/client";

export async function runSpeculativeHoldExpiryWorker(prisma: PrismaClient, input: { holdId?: string; timerRecordId?: string }) {
  const now = new Date();
  const holdId = typeof input.holdId === "string" ? input.holdId : undefined;
  if (!holdId) return { skipped: true, reason: "MISSING_HOLD_ID" } as const;

  const hold = await prisma.speculativeHold.findUnique({ where: { id: holdId } });
  if (!hold) return { skipped: true, reason: "HOLD_NOT_FOUND" } as const;
  if (hold.state === HoldState.RELEASED || hold.state === HoldState.UPGRADED) {
    return { skipped: true, reason: "HOLD_ALREADY_RESOLVED" } as const;
  }

  await prisma.$transaction(async (tx) => {
    await tx.speculativeHold.update({
      where: { id: holdId },
      data: { state: HoldState.RELEASED, releasedAt: now, releasedBy: "SYSTEM", releaseReason: "EXPIRY" },
    });

    if (hold.roomId) {
      const room = await tx.room.findUnique({ where: { id: hold.roomId } });
      if (room) {
        await tx.room.update({ where: { id: hold.roomId }, data: { currentClaimState: InventoryClaimState.FREE } });
        await tx.roomClaimStateEvent.create({
          data: {
            roomId: hold.roomId,
            entryId: hold.entryId,
            fromState: InventoryClaimState.SPECULATIVELY_HELD,
            toState: InventoryClaimState.FREE,
            actorId: "SYSTEM",
            reason: "SPECULATIVE_HOLD_EXPIRED",
            effectiveFrom: now,
          },
        });
      }
    }

    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "SPECULATIVE_HOLD.EXPIRY_TRIGGERED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "SpeculativeHold",
        entityId: holdId,
        operation: "EXPIRE",
        timestamp: now,
        stageContext: Stage.S2,
        inquiryId: null,
        entryId: hold.entryId,
        payload: { holdId, entryId: hold.entryId, roomId: hold.roomId, spaceId: hold.spaceId, expiresAt: hold.expiresAt.toISOString() },
        createdBy: "SYSTEM",
      },
    });
  });

  return { skipped: false, holdId } as const;
}

