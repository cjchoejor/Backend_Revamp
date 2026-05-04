import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState, HandoffState, HandoffType, NightAuditRunStatus, RoomPhysicalState, Stage, TaskStatus } from "@prisma/client";
import { NotFoundError, OptimisticLockError, PolicyGateBlockedError, StageGateBlockedError, ValidationError } from "../lib/errors.js";
import * as checkInService from "./check-in-service.js";
import * as disputeService from "./s7-dispute-service.js";

function num(d: Prisma.Decimal | null | undefined): number {
  if (d == null) return 0;
  return Number(d.toString());
}

/** SIG-S5 — S5 → S6 (guest at desk; pre-arrival gates). Folio stays PROVISIONAL. */
export async function progressStageS5ToS6(
  prisma: PrismaClient,
  entryId: string,
  _actorId: string,
  clientVersion: number | undefined,
  guestPhysicallyPresent: boolean | undefined,
) {
  if (clientVersion == null || clientVersion === undefined) {
    throw new OptimisticLockError();
  }

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      reservation: true,
      folio: true,
      handoffs: { where: { handoffType: HandoffType.H1 }, orderBy: { createdAt: "desc" }, take: 1 },
      preArrivalTasks: true,
      roomAssignments: { include: { room: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S5) {
    throw new StageGateBlockedError("Entry is not at S5", "NOT_AT_S5");
  }

  if (clientVersion !== entry.version) {
    throw new OptimisticLockError();
  }

  if (!guestPhysicallyPresent) {
    throw new StageGateBlockedError("Guest physical presence is required for S5→S6", "GUEST_NOT_PRESENT");
  }

  const awaitingTimer = await prisma.timerRecord.findFirst({
    where: { entryId, timerCode: "AWAITING_WRITTEN_CONFIRMATION_W5", status: "SCHEDULED" },
    orderBy: { createdAt: "desc" },
  });
  if (awaitingTimer) {
    throw new StageGateBlockedError("Awaiting written confirmation — cannot progress", "AWAITING_WRITTEN_CONFIRMATION");
  }

  const h1 = entry.handoffs[0];
  if (!h1 || h1.state !== HandoffState.FULFILLED) {
    throw new StageGateBlockedError("H1 handoff must be FULFILLED before check-in", "H1_NOT_FULFILLED");
  }

  const assignment = entry.roomAssignments[0];
  if (!assignment) {
    throw new StageGateBlockedError("Room assignment is required", "NO_ROOM_ASSIGNMENT");
  }

  const room = assignment.room;
  const arrival = entry.reservation?.frozenCheckInDate ?? entry.checkInDate;
  const roomOk =
    room.physicalState === RoomPhysicalState.AVAILABLE_CLEAN ||
    room.physicalState === RoomPhysicalState.AVAILABLE_INSPECTED ||
    (room.physicalState === RoomPhysicalState.UNDER_MAINTENANCE &&
      room.expectedReadyAt != null &&
      arrival != null &&
      room.expectedReadyAt <= arrival);

  if (!roomOk) {
    throw new StageGateBlockedError("Assigned room is not in a valid physical state for arrival", "ROOM_NOT_READY");
  }

  if (assignment.deficientAtAssignment && (!assignment.acknowledgementActorId || !assignment.acknowledgementAt)) {
    throw new StageGateBlockedError("DEFICIENT assignment lacks acknowledgement", "DEFICIENT_NOT_DOCUMENTED");
  }

  const pendingTask = entry.preArrivalTasks.find((t) => t.status === TaskStatus.PENDING);
  if (pendingTask) {
    throw new StageGateBlockedError(`Pre-arrival task still PENDING: ${pendingTask.taskType}`, "PRE_ARRIVAL_TASK_PENDING");
  }

  if (!entry.folio || entry.folio.state !== FolioState.PROVISIONAL) {
    throw new StageGateBlockedError("Folio must be PROVISIONAL for normal S5→S6 path", "FOLIO_NOT_PROVISIONAL");
  }

  if (!entry.folio.advancePaymentReconciliationComplete) {
    throw new StageGateBlockedError("Advance payment reconciliation not complete", "RECONCILIATION_INCOMPLETE");
  }

  const ceiling = entry.reservation?.creditCeilingIfExtended;
  if (ceiling != null) {
    const ceilingN = num(ceiling);
    const out = num(entry.folio.outstandingBalance);
    if (ceilingN > 0 && out / ceilingN >= 0.9 && !entry.creditCeilingTier2AcknowledgedAt) {
      throw new StageGateBlockedError(
        "Credit ceiling Tier 2 proximity requires FOM acknowledgement before check-in",
        "CREDIT_CEILING_TIER2_UNACKNOWLEDGED",
      );
    }
  }

  const now = new Date();
  const s5Dwell = await prisma.stageDwellRecord.findFirst({
    where: { entryId, stage: Stage.S5, exitedAt: null },
    orderBy: { enteredAt: "desc" },
  });

  await prisma.$transaction(async (tx) => {
    if (s5Dwell) {
      await tx.stageDwellRecord.update({
        where: { id: s5Dwell.id },
        data: { exitedAt: now },
      });
    }
    await tx.stageDwellRecord.create({
      data: { entryId, stage: Stage.S6, enteredAt: now },
    });
    await tx.entry.update({
      where: { id: entryId },
      data: {
        currentStage: Stage.S6,
        version: { increment: 1 },
        updatedAt: now,
      },
    });
  });

  return prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
}

/** SIG-S6 §8.2 — S6 → S7 (check-in completion: folio LIVE, OCCUPIED, H2/H3, keys, registration). */
export async function progressStageS6ToS7(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  clientVersion: number | undefined,
  keyCount: number | undefined,
  registrationConfirmed: boolean | undefined,
) {
  return checkInService.completeCheckInToS7(prisma, entryId, actorId, clientVersion, keyCount, registrationConfirmed);
}

/** SIG-S6 §5.2 / AC-S6-036 — S6→S1 re-entry (room change at check-in). */
export async function reEnterS6ToS1(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      roomAssignments: { orderBy: { createdAt: "desc" }, take: 1, include: { room: true } },
      handoffs: { where: { handoffType: { in: [HandoffType.H2, HandoffType.H3] }, stageContext: Stage.S6 }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S6) throw new StageGateBlockedError("Entry must be at S6 for re-entry", "NOT_AT_S6");

  const now = new Date();
  const nextSegmentNumber = entry.segmentNumber + 1;
  const handoffIds = entry.handoffs.map((h) => h.id);
  const room = entry.roomAssignments[0]?.room;

  await prisma.$transaction(async (tx) => {
    // Cancel H2/H3 for original assignment context.
    if (handoffIds.length > 0) {
      await tx.handoffRecord.updateMany({
        where: { id: { in: handoffIds }, state: { in: [HandoffState.CREATED, HandoffState.ACCEPTED, HandoffState.ESCALATED, HandoffState.REJECTED, HandoffState.FULFILLED] } },
        data: { state: HandoffState.CANCELLED, cancelledAt: now, cancelledBy: actorId, cancelledReason: "REENTRY_S6_TO_S1" },
      });
      await tx.timerRecord.updateMany({
        where: { entityType: "HandoffRecord", entityId: { in: handoffIds }, timerCode: "H2_H3_ACCEPTANCE_W25", status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "REENTRY_S6_TO_S1" },
      });
    }

    // Release original room claim (CONFIRMED/OCCUPIED → FREE).
    if (room && room.currentClaimState !== "FREE") {
      const fromState = room.currentClaimState;
      await tx.room.update({ where: { id: room.id }, data: { currentClaimState: "FREE", updatedAt: now } });
      await tx.roomClaimStateEvent.create({
        data: { roomId: room.id, entryId, fromState: fromState as any, toState: "FREE", actorId, reason: "REENTRY_S6_TO_S1", effectiveFrom: now },
      });
    }

    await tx.segment.create({
      data: { entryId, segmentNumber: nextSegmentNumber, stage: Stage.S1, startedAt: now, createdBy: actorId, notes: "REENTRY_S6_TO_S1" },
    });
    await tx.entry.update({
      where: { id: entryId },
      data: { currentStage: Stage.S1, segmentNumber: nextSegmentNumber, version: { increment: 1 }, updatedAt: now },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.REENTRY_S6_TO_S1",
        actorId,
        actorLevel: "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S6,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, toStage: "S1", segmentNumber: nextSegmentNumber, cancelledHandoffIds: handoffIds },
        createdBy: actorId,
      },
    });
  });

  return prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
}

/** SIG-S7 — S7 → S8 (exit stay to checkout prep). */
export async function progressStageS7ToS8(prisma: PrismaClient, entryId: string, _actorId: string, clientVersion: number | undefined) {
  if (clientVersion == null) {
    throw new ValidationError("version is required for S7→S8 progression");
  }

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      reservation: true,
      roomAssignments: { orderBy: { createdAt: "desc" }, take: 1, include: { room: true } },
      handoffs: { where: { handoffType: HandoffType.H4 }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S7) throw new StageGateBlockedError("Entry is not at S7", "NOT_AT_S7");
  if (entry.version !== clientVersion) throw new OptimisticLockError();

  const assignment = entry.roomAssignments[0];
  if (!assignment) throw new StageGateBlockedError("Occupied room is required to exit S7", "NO_OCCUPIED_ROOM");

  const deficient = await prisma.deficientConditionRecord.findMany({ where: { roomId: assignment.roomId } });
  const bad = deficient.find((d) => d.status !== "RESOLVED" && d.status !== "UNRESOLVED");
  if (bad) {
    throw new StageGateBlockedError("DEFICIENT condition missing final status", "DEFICIENT_NO_FINAL_STATUS");
  }

  const h4 = entry.handoffs[0];
  if (!h4 || !["CREATED", "ACCEPTED", "FULFILLED"].includes(h4.state) || h4.rejectedAt) {
    // Same-day departures can auto-fulfil H4 at exit time (AC-S7-16).
    const checkout = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate;
    const now = new Date();
    const isSameDayDeparture = checkout ? checkout.toISOString().slice(0, 10) === now.toISOString().slice(0, 10) : false;
    if (!isSameDayDeparture) {
      throw new StageGateBlockedError("H4 must be initiated before S7→S8", "H4_NOT_INITIATED");
    }
  }

  // Night audit must have sealed the last operating date before checkout.
  const checkout = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate;
  if (!checkout) throw new StageGateBlockedError("checkOutDate missing", "MISSING_CHECKOUT_DATE");
  const lastNight = new Date(Date.UTC(checkout.getUTCFullYear(), checkout.getUTCMonth(), checkout.getUTCDate() - 1, 0, 0, 0, 0));
  const audit = await prisma.nightAuditRecord.findUnique({ where: { operatingDate: lastNight } });
  if (!audit || audit.runStatus !== NightAuditRunStatus.COMPLETE) {
    throw new StageGateBlockedError("Night audit must be COMPLETE for last operating date before checkout", "NIGHT_AUDIT_NOT_COMPLETE");
  }

  const disputeGate = await disputeService.canProgressToS8(prisma, entryId);
  if (disputeGate === "BLOCKED_WITH_OVERRIDE_AVAILABLE") {
    throw new PolicyGateBlockedError("DISPUTE_GATE_BLOCKED", "Dispute gate blocks S7→S8 until GM override is recorded");
  }

  const now = new Date();
  const s7Dwell = await prisma.stageDwellRecord.findFirst({
    where: { entryId, stage: Stage.S7, exitedAt: null },
    orderBy: { enteredAt: "desc" },
  });

  await prisma.$transaction(async (tx) => {
    // If H4 missing but same-day departure, auto-create + auto-fulfil (AC-S7-16).
    if (!h4 || !["CREATED", "ACCEPTED", "FULFILLED"].includes(h4.state) || h4.rejectedAt) {
      const checkout = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate;
      const today = now.toISOString().slice(0, 10);
      const isSameDayDeparture = checkout ? checkout.toISOString().slice(0, 10) === today : false;
      if (isSameDayDeparture) {
        const created = await tx.handoffRecord.create({
          data: {
            entryId,
            handoffType: HandoffType.H4,
            state: "FULFILLED",
            fromRole: "FRONT_DESK",
            fromActorId: _actorId ?? "SYSTEM",
            toRole: "HOUSEKEEPING",
            checklistContent: { auto: true } as any,
            fulfilmentEvidence: { autoFulfilled: true, basis: "SAME_DAY_DEPARTURE" } as any,
            fulfilledAt: now,
            fulfilledBy: "SYSTEM",
            isAutoFulfilled: true,
            createdBy: _actorId ?? "SYSTEM",
            stageContext: Stage.S7,
          } as any,
        });
        await tx.traceEvent.create({
          data: {
            eventType: "HANDOFF.H4_AUTO_FULFILLED",
            actorId: "SYSTEM",
            actorLevel: "SYSTEM",
            entityType: "HandoffRecord",
            entityId: created.id,
            operation: "TRANSITION",
            timestamp: now,
            stageContext: Stage.S7,
            inquiryId: entry.inquiryId,
            entryId,
            payload: { handoffId: created.id, entryId, basis: "SAME_DAY_DEPARTURE" },
            createdBy: "SYSTEM",
          },
        });
      }
    }
    if (s7Dwell) await tx.stageDwellRecord.update({ where: { id: s7Dwell.id }, data: { exitedAt: now } });
    await tx.stageDwellRecord.create({ data: { entryId, stage: Stage.S8, enteredAt: now } });
    await tx.entry.update({
      where: { id: entryId },
      data: { currentStage: Stage.S8, version: { increment: 1 }, updatedAt: now },
    });

    // AC-S7-14: if exiting S7 with an unresolved deficient condition, mark it as unresolved-at-checkout.
    await tx.deficientConditionRecord.updateMany({
      where: { roomId: assignment.roomId, status: "UNRESOLVED" },
      data: { status: "DEFICIENT_UNRESOLVED_AT_CHECKOUT" },
    });
  });

  return prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
}
