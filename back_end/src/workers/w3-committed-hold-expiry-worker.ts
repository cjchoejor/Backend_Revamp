import type { PrismaClient } from "@prisma/client";
import { HoldState, Stage } from "@prisma/client";
import { enforceCommittedHoldEligibleForExpiryTransition } from "../policies/11-committed-hold/p08-committed-hold-expiry-policy-slice.js";
import { releaseEntryRoomsToFree } from "../lib/room-claim-state.js";

export async function runCommittedHoldExpiryWorker(prisma: PrismaClient, input: { committedHoldId?: string; timerRecordId?: string }) {
  const now = new Date();
  const committedHoldId = typeof input.committedHoldId === "string" ? input.committedHoldId : undefined;
  if (!committedHoldId) return { skipped: true, reason: "MISSING_COMMITTED_HOLD_ID" } as const;

  const hold = await prisma.committedHold.findUnique({ where: { id: committedHoldId } });
  if (!hold) return { skipped: true, reason: "HOLD_NOT_FOUND" } as const;
  const { eligible } = enforceCommittedHoldEligibleForExpiryTransition({ state: hold.state });
  if (!eligible) return { skipped: true, reason: "ALREADY_RESOLVED" } as const;

  await prisma.$transaction(async (tx) => {
    await tx.committedHold.update({
      where: { id: committedHoldId },
      data: { state: HoldState.RELEASED, releasedAt: now, releasedBy: "SYSTEM", releaseReason: "EXPIRY" },
    });

    // Release EVERY room the hold pinned — not just hold.roomId. Multi-room bookings
    // (s3-hold-service pins all sealed rooms since 2026-07-13) were leaking rooms 2..N
    // on TTL expiry because this worker only touched the primary. See the 2026-07-25 gap
    // analysis (repair-stuck-room-states.ts).
    await releaseEntryRoomsToFree(tx, {
      entryId: hold.entryId,
      actorId: "SYSTEM",
      reason: "COMMITTED_HOLD_EXPIRED",
      now,
    });

    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "COMMITTED_HOLD.EXPIRY_TRIGGERED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "CommittedHold",
        entityId: committedHoldId,
        operation: "EXPIRE",
        timestamp: now,
        stageContext: Stage.S3,
        entryId: hold.entryId,
        payload: { committedHoldId, entryId: hold.entryId, expiresAt: hold.expiresAt.toISOString() },
        createdBy: "SYSTEM",
      },
    });
  });

  return { skipped: false, committedHoldId } as const;
}

