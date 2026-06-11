import type { PrismaClient } from "@prisma/client";
import { RoomPhysicalState, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { requireDeficientRoomAcknowledgement } from "../../policies/19-deficient-condition/p48-deficient-room-assignment-decision.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import {
  enforceArrivalDatePresentForRoomAssignment,
  enforceCommittedHoldPresentForRoomAssignment,
  enforceNoExistingRoomAssignmentOnS5Path,
  enforceRoomAssignmentEntryStage,
  enforceRoomPhysicallyAssignableForS5,
  enforceRoomTypeMatchesHoldForAssignment,
} from "../../policies/01-availability/p01-s5-room-assignment-eligibility-gates.js";

export type DeficientAck = {
  acknowledgementActorId: string;
  acknowledgementAt: string;
  decisionTaken: string;
};

export async function assignRoom(
  prisma: PrismaClient,
  entryId: string,
  roomId: string,
  actorId: string,
  notes: string | undefined,
  deficientAcknowledgement: DeficientAck | undefined,
  opts?: { reEntryToS1?: boolean },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { reservation: true, committedHold: true },
  });

  if (!entry) throw new NotFoundError("Entry");
  enforceRoomAssignmentEntryStage({ currentStage: entry.currentStage, reEntryToS1: opts?.reEntryToS1 });

  if (entry.currentStage === Stage.S5) {
    const existing = await prisma.roomAssignment.findFirst({ where: { entryId } });
    enforceNoExistingRoomAssignmentOnS5Path({ currentStage: entry.currentStage, hasExistingAssignment: !!existing });
  }

  const hold = entry.committedHold;
  enforceCommittedHoldPresentForRoomAssignment({ hold });
  const holdRecord = hold!;

  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { deficientConditionRecords: { where: { status: "UNRESOLVED" } } },
  });

  if (!room) throw new NotFoundError("Room");

  enforceRoomTypeMatchesHoldForAssignment({ roomRoomTypeId: room.roomTypeId, holdRoomTypeId: holdRecord.roomTypeId });

  const arrival =
    entry.reservation?.frozenCheckInDate ??
    entry.checkInDate ??
    (opts?.reEntryToS1 === true ? new Date() : null);
  enforceArrivalDatePresentForRoomAssignment({ arrival });
  const arrivalDate = arrival!;

  enforceRoomPhysicallyAssignableForS5({
    physicalState: room.physicalState,
    expectedReadyAt: room.expectedReadyAt,
    arrival: arrivalDate,
  });

  const activeDef = room.deficientConditionRecords[0];
  const isDeficient = !!activeDef;

  if (isDeficient) {
    const { acknowledgementAt } = requireDeficientRoomAcknowledgement(deficientAcknowledgement);
    const acknowledgementActorId = deficientAcknowledgement!.acknowledgementActorId;
    const roomAssignmentId = await allocateReadableId(prisma, "ROOM_ASSIGNMENT" as const);
    const created = await prisma.roomAssignment.create({
      data: {
        id: roomAssignmentId,
        entryId,
        roomId,
        assignedBy: actorId,
        deficientAtAssignment: true,
        deficientConditionRecordId: activeDef.id,
        acknowledgementActorId,
        acknowledgementAt,
        notes,
      },
    });
    await maybeRegisterRoomReadinessSla(prisma, entryId, roomId, actorId, room.physicalState);
    return created;
  }

  if (deficientAcknowledgement) {
    throw new ValidationError("deficientAcknowledgement must not be sent when room is not DEFICIENT");
  }

  const roomAssignmentId = await allocateReadableId(prisma, "ROOM_ASSIGNMENT" as const);
  const created = await prisma.roomAssignment.create({
    data: {
      id: roomAssignmentId,
      entryId,
      roomId,
      assignedBy: actorId,
      deficientAtAssignment: false,
      notes,
    },
  });
  if (entry.currentStage === Stage.S5) {
    await maybeRegisterRoomReadinessSla(prisma, entryId, roomId, actorId, room.physicalState);
  }
  return created;
}

async function maybeRegisterRoomReadinessSla(
  prisma: PrismaClient,
  entryId: string,
  roomId: string,
  actorId: string,
  physicalState: RoomPhysicalState,
) {
  const isReady = physicalState === RoomPhysicalState.AVAILABLE_CLEAN || physicalState === RoomPhysicalState.AVAILABLE_INSPECTED;
  if (isReady) return;

  const now = new Date();
  const windowMinutes =
    (await requireActiveConfigValue<number | null>(prisma, "housekeeping.sla.readinessWindowMinutes", { now }).catch(() => null)) ??
    (await requireActiveConfigValue<number>(prisma, "housekeeping.sla.windowMinutes", { now }));
  const firesAt = new Date(now.getTime() + windowMinutes * 60_000);

  const existing = await prisma.timerRecord.findFirst({
    where: { entryId, timerCode: "ROOM_READINESS_SLA_W23", status: "SCHEDULED" },
    orderBy: { createdAt: "desc" },
  });
  if (existing) return;

  const engine = await getTimerEngine();
  const jobId = await engine.schedule("ROOM_READINESS_SLA_W23", { entryId, roomId, phase: "BREACH" }, { startAfter: firesAt });
  await prisma.timerRecord.create({
    data: {
      entryId,
      entityType: "Room",
      entityId: roomId,
      timerType: "ROOM_READINESS_SLA_W23",
      timerCode: "ROOM_READINESS_SLA_W23",
      stageContext: Stage.S5,
      firesAt,
      dueAt: firesAt,
      status: "SCHEDULED",
      payload: { entryId, roomId, phase: "BREACH", physicalState },
      pgBossJobId: jobId,
      createdBy: actorId,
    },
  });
}

/** SIG-S6 §5.1 — guest arrived at S6; cancel pending room-readiness SLA timers for this entry. */
export async function cancelScheduledRoomReadinessSlaForEntry(
  prisma: PrismaClient,
  entryId: string,
  cancelledBy: string,
  cancelledReason: string,
) {
  const timers = await prisma.timerRecord.findMany({
    where: { entryId, timerCode: "ROOM_READINESS_SLA_W23", status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
  });
  if (timers.length === 0) return { cancelled: 0 } as const;
  const now = new Date();
  await prisma.timerRecord.updateMany({
    where: { id: { in: timers.map((t) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy, cancelledReason } as any,
  });
  Promise.resolve().then(async () => {
    try {
      const engine = await getTimerEngine();
      await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
    } catch {
      // best-effort pg-boss cancel
    }
  });
  return { cancelled: timers.length } as const;
}
