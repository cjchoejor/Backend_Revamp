import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState, HandoffState, HandoffType, NightAuditRunStatus, RoomPhysicalState, Stage, TaskStatus } from "@prisma/client";
import { NotFoundError, OptimisticLockError, PolicyGateBlockedError, StageGateBlockedError } from "../lib/errors.js";
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

  if (entry.awaitingWrittenConfirmationActive) {
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

/** SIG-S7 — S7 → S8 (exit stay to checkout prep). */
export async function progressStageS7ToS8(prisma: PrismaClient, entryId: string, _actorId: string, clientVersion: number | undefined) {
  if (clientVersion == null || clientVersion === undefined) throw new OptimisticLockError();

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
    throw new StageGateBlockedError("H4 must be initiated before S7→S8", "H4_NOT_INITIATED");
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
    if (s7Dwell) await tx.stageDwellRecord.update({ where: { id: s7Dwell.id }, data: { exitedAt: now } });
    await tx.stageDwellRecord.create({ data: { entryId, stage: Stage.S8, enteredAt: now } });
    await tx.entry.update({
      where: { id: entryId },
      data: { currentStage: Stage.S8, version: { increment: 1 }, updatedAt: now },
    });
  });

  return prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
}
