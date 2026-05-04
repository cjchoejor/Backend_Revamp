import type { PrismaClient } from "@prisma/client";
import { HandoffState, Stage } from "@prisma/client";
import type { TimerEngine } from "../lib/timer-engine.js";

export async function runHandoffAcceptanceWorker(
  prisma: PrismaClient,
  _engine: TimerEngine,
  input: { handoffId?: string; timerRecordId?: string; eventPhase?: "EXPIRY" },
) {
  const now = new Date();
  const handoffId = typeof input.handoffId === "string" ? input.handoffId : undefined;
  if (!handoffId) return { skipped: true, reason: "MISSING_HANDOFF_ID" } as const;

  const handoff = await prisma.handoffRecord.findUnique({ where: { id: handoffId } });
  if (!handoff) return { skipped: true, reason: "HANDOFF_NOT_FOUND" } as const;

  // Resolved states skip (SIG-S6 W25 idempotency).
  const resolvedStates: HandoffState[] = [HandoffState.ACCEPTED, HandoffState.FULFILLED, HandoffState.CLOSED];
  if (resolvedStates.includes(handoff.state)) {
    return { skipped: true, reason: "ALREADY_RESOLVED" } as const;
  }
  if (handoff.state === HandoffState.REJECTED) return { skipped: true, reason: "REJECTED" } as const;

  await prisma.$transaction(async (tx) => {
    await tx.handoffRecord.update({
      where: { id: handoffId },
      data: { state: HandoffState.ESCALATED, escalatedAt: now },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "HANDOFF.ACCEPTANCE_WINDOW_EXPIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "HandoffRecord",
        entityId: handoffId,
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S6,
        inquiryId: null,
        entryId: handoff.entryId,
        payload: { handoffId, entryId: handoff.entryId, handoffType: handoff.handoffType, toRole: handoff.toRole },
        createdBy: "SYSTEM",
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "HANDOFF.FOM_ALERTED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "HandoffRecord",
        entityId: handoffId,
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S6,
        inquiryId: null,
        entryId: handoff.entryId,
        payload: { handoffId, entryId: handoff.entryId, reason: "ACCEPTANCE_WINDOW_EXPIRED" },
        createdBy: "SYSTEM",
      },
    });
    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } });
    }
  });

  return { skipped: false, handoffId } as const;
}

