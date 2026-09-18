import type { Prisma, PrismaClient } from "@prisma/client";
import { HandoffState, Stage } from "@prisma/client";
import type { TimerEngine } from "../lib/timer-engine.js";
import { HANDOFF_ACCEPTANCE_TIMER_CODES } from "../lib/handoff-acceptance-timers.js";

export async function runHandoffAcceptanceWorker(
  prisma: PrismaClient,
  _engine: TimerEngine,
  input: { handoffId?: string; timerRecordId?: string; eventPhase?: "EXPIRY" },
) {
  const now = new Date();
  const handoffId = typeof input.handoffId === "string" ? input.handoffId : undefined;
  if (!handoffId) return { skipped: true, reason: "MISSING_HANDOFF_ID" } as const;

  const handoff = await prisma.handoffRecord.findUnique({ where: { id: handoffId } });

  // This job IS the clock firing, so its TimerRecord is marked FIRED on every path — including the
  // skips (2026-09-18). The schedule sites never put a timerRecordId in the job, so the record is
  // found by its handoff; before this, every W25 clock stayed SCHEDULED forever once it had fired,
  // and the desk counted it as days overdue. A clock stopped at the row (CANCELLED — accepted,
  // cancelled by a room change or re-entry) whose pg-boss job still fired acts on nothing.
  const clocks = await prisma.timerRecord.findMany({
    where: {
      entityType: "HandoffRecord",
      entityId: handoffId,
      timerCode: { in: HANDOFF_ACCEPTANCE_TIMER_CODES },
      ...(typeof input.timerRecordId === "string" ? { id: input.timerRecordId } : {}),
    },
    select: { id: true, status: true, dueAt: true },
  });
  const firing = clocks.filter((c) => c.status === "SCHEDULED" && c.dueAt.getTime() <= now.getTime() + 60_000);
  const markFired = (db: Pick<PrismaClient, "timerRecord"> | Prisma.TransactionClient) =>
    firing.length
      ? db.timerRecord.updateMany({ where: { id: { in: firing.map((c) => c.id) }, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } })
      : Promise.resolve({ count: 0 });

  if (!handoff) {
    await markFired(prisma);
    return { skipped: true, reason: "HANDOFF_NOT_FOUND" } as const;
  }
  if (clocks.length > 0 && !clocks.some((c) => c.status === "SCHEDULED")) {
    return { skipped: true, reason: "TIMER_NOT_SCHEDULED" } as const;
  }

  // Resolved states skip (SIG-S6 W25 idempotency). CANCELLED and ESCALATED joined 2026-09-18: a
  // cancelled handoff must never be escalated back to life, and an escalated one already was.
  const resolvedStates: HandoffState[] = [
    HandoffState.ACCEPTED,
    HandoffState.FULFILLED,
    HandoffState.CLOSED,
    HandoffState.CANCELLED,
    HandoffState.ESCALATED,
  ];
  if (resolvedStates.includes(handoff.state)) {
    await markFired(prisma);
    return { skipped: true, reason: "ALREADY_RESOLVED" } as const;
  }
  if (handoff.state === HandoffState.REJECTED) {
    await markFired(prisma);
    return { skipped: true, reason: "REJECTED" } as const;
  }

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
    await markFired(tx);
  });

  return { skipped: false, handoffId } as const;
}

