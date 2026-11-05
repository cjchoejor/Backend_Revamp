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
  // The block's own time decides: one moved or placed again since this job was armed has not ended.
  if (hold.expiresAt.getTime() > now.getTime() + 5000) return { skipped: true, reason: "NOT_DUE" } as const;

  // At Set up the block does NOT let go of the rooms when its time ends (2026-11-05, operator: "if a
  // block ends dont release it directly, mark it very Crtical and send the notification to FOM and
  // GM, they will get into the booking, consult the guest, and then will cancel it, or release it").
  // The rooms stay held, and everything reads the time itself, so this needs no running worker to be
  // true: this only closes the clock and tells them. Elsewhere nobody can act on it, so it lets go.
  const entry = await prisma.entry.findUnique({ where: { id: hold.entryId }, select: { currentStage: true, status: true, inquiryId: true } });
  if (entry?.currentStage === Stage.S3 && (entry.status === "ACTIVE" || entry.status === "PARKED")) {
    await prisma.$transaction(async (tx) => {
      await tx.timerRecord.updateMany({
        where:
          typeof input.timerRecordId === "string"
            ? { id: input.timerRecordId, status: "SCHEDULED" }
            : { timerCode: "COMMITTED_HOLD_EXPIRY_W3", entityType: "CommittedHold", entityId: committedHoldId, status: "SCHEDULED" },
        data: { status: "FIRED", firedAt: now },
      });
      // Told once for each time it ends: a job sent again must not tell them twice. A new block time
      // that also ends is a new moment, and they are told again.
      const told = await tx.traceEvent.findFirst({
        where: { entityId: committedHoldId, eventType: "COMMITTED_HOLD.TIME_ENDED", payload: { path: ["expiresAt"], equals: hold.expiresAt.toISOString() } },
        select: { id: true },
      });
      if (told) return;
      for (const eventType of ["COMMITTED_HOLD.TIME_ENDED", "NOTIFICATION.BLOCK_TIME_ENDED"]) {
        await tx.traceEvent.create({
          data: {
            eventType,
            actorId: "SYSTEM",
            actorLevel: "SYSTEM",
            entityType: "CommittedHold",
            entityId: committedHoldId,
            operation: "UPDATE",
            timestamp: now,
            stageContext: Stage.S3,
            inquiryId: entry.inquiryId,
            entryId: hold.entryId,
            payload: {
              committedHoldId,
              entryId: hold.entryId,
              expiresAt: hold.expiresAt.toISOString(),
              ...(eventType.startsWith("NOTIFICATION.") ? { severity: "CRITICAL", targets: ["FOM", "GM"], stage: "S3" } : {}),
            },
            createdBy: "SYSTEM",
          },
        });
      }
    });
    return { skipped: false, committedHoldId, kept: true } as const;
  }

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

    // The clock that fired is marked FIRED (2026-09-18). The hold's job never carried the record's
    // id, so the record stayed SCHEDULED after the hold ran out and the rail read it as overdue.
    await tx.timerRecord.updateMany({
      where:
        typeof input.timerRecordId === "string"
          ? { id: input.timerRecordId, status: "SCHEDULED" }
          : { timerCode: "COMMITTED_HOLD_EXPIRY_W3", entityType: "CommittedHold", entityId: committedHoldId, status: "SCHEDULED" },
      data: { status: "FIRED", firedAt: now },
    });

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

