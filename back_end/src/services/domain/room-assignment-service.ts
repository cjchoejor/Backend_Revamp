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
  opts?: {
    reEntryToS1?: boolean;
    /**
     * Optional inclusive start / exclusive end of the assignment. Populated when the
     * caller knows the assignment applies to a specific date range (e.g., driven from a
     * per-night sealed AvailabilityConfiguration). NULL both = whole-stay assignment
     * (legacy behavior preserved).
     */
    startDate?: Date;
    endDate?: Date;
  },
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
        ...(opts?.startDate ? { startDate: opts.startDate } : {}),
        ...(opts?.endDate ? { endDate: opts.endDate } : {}),
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
      ...(opts?.startDate ? { startDate: opts.startDate } : {}),
      ...(opts?.endDate ? { endDate: opts.endDate } : {}),
    },
  });
  if (entry.currentStage === Stage.S5) {
    await maybeRegisterRoomReadinessSla(prisma, entryId, roomId, actorId, room.physicalState);
  }
  return created;
}

/**
 * Bulk-assign rooms for an entry driven from a sealed per-night AvailabilityConfiguration.
 *
 * Reads `entry.availabilityConfigs[latest sealed].optionSelected.perNight`, folds
 * consecutive nights of the same room into contiguous date ranges, then creates one
 * RoomAssignment row per (roomId, contiguous-range) with startDate + endDate populated.
 *
 * When there's no per-night breakdown (whole-stay or single-room seals), does nothing —
 * caller should fall back to the single-room `assignRoom` path.
 *
 * Returns the assignments created (empty array if the config wasn't per-night).
 */
export async function assignRoomsFromSealedPerNight(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
): Promise<Array<{ id: string; roomId: string; startDate: Date; endDate: Date }>> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      availabilityConfigs: {
        where: { sealedAt: { not: null } },
        orderBy: { sealedAt: "desc" },
        take: 1,
      },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  const cfg = entry.availabilityConfigs[0];
  const opt = (cfg?.optionSelected ?? null) as
    | { perNight?: Array<{ date: string; roomIds: Array<{ roomId: string; isDeficient: boolean }> }> }
    | null;
  if (!opt || !Array.isArray(opt.perNight) || opt.perNight.length === 0) return [];

  // Fold: for each roomId that appears in the perNight data, find its contiguous night
  // ranges. Example: room 201 on Jul 15+16, room 301 on Jul 17 → two ranges:
  //   room 201: [Jul 15, Jul 17) exclusive-endDate
  //   room 301: [Jul 17, Jul 18)
  const nightsByRoom = new Map<string, string[]>();
  for (const n of opt.perNight) {
    for (const r of n.roomIds) {
      if (!nightsByRoom.has(r.roomId)) nightsByRoom.set(r.roomId, []);
      nightsByRoom.get(r.roomId)!.push(n.date);
    }
  }

  const rangesToCreate: Array<{ roomId: string; startDate: Date; endDate: Date }> = [];
  for (const [roomId, nights] of nightsByRoom) {
    const sorted = [...new Set(nights)].sort();
    let runStart = sorted[0];
    let prev = sorted[0];
    for (let i = 1; i <= sorted.length; i++) {
      const next = i < sorted.length ? sorted[i] : null;
      // Contiguous iff next = prev + 1 day.
      const prevMs = Date.UTC(Number(prev.slice(0, 4)), Number(prev.slice(5, 7)) - 1, Number(prev.slice(8, 10)));
      const expected = new Date(prevMs + 86_400_000).toISOString().slice(0, 10);
      if (next === expected) {
        prev = next;
        continue;
      }
      // Close the run.
      const [ys, ms, ds] = runStart.split("-").map(Number);
      const [ye, me, de] = prev.split("-").map(Number);
      rangesToCreate.push({
        roomId,
        startDate: new Date(Date.UTC(ys, ms - 1, ds)),
        endDate: new Date(Date.UTC(ye, me - 1, de) + 86_400_000), // exclusive checkout
      });
      if (next) {
        runStart = next;
        prev = next;
      }
    }
  }

  const created: Array<{ id: string; roomId: string; startDate: Date; endDate: Date }> = [];
  for (const r of rangesToCreate) {
    // Skip when an assignment for this (entryId, roomId, startDate) already exists so the
    // helper is idempotent on retry.
    const existing = await prisma.roomAssignment.findFirst({
      where: { entryId, roomId: r.roomId, startDate: r.startDate },
    });
    if (existing) {
      created.push({ id: existing.id, roomId: r.roomId, startDate: r.startDate, endDate: r.endDate });
      continue;
    }
    const id = await allocateReadableId(prisma, "ROOM_ASSIGNMENT" as const);
    const row = await prisma.roomAssignment.create({
      data: {
        id,
        entryId,
        roomId: r.roomId,
        assignedBy: actorId,
        deficientAtAssignment: false,
        startDate: r.startDate,
        endDate: r.endDate,
        notes: "auto-created from sealed per-night configuration",
      },
    });
    created.push({ id: row.id, roomId: row.roomId, startDate: r.startDate, endDate: r.endDate });
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
