/**
 * Housekeeping — which rooms need cleaning, and the act that marks one clean (2026-10-26,
 * operator: "after a room has been departed we don't have anywhere we can mark it clean … mainly
 * for housekeeping staff, where in the future we can monitor it, and a separate app for
 * housekeeping where they can update it from their phones").
 *
 * A room needs cleaning when its flag reads DEPARTED_DIRTY (every departure writes it: check-out,
 * a room left mid-stay, one room of a party released early) or its physical state reads DIRTY.
 * Marking it clean puts the flag back to what the room's bookings say it should read — FREE, or
 * the next booking's hold — through the same rule the flag repair uses (`readExpectedRoomFlags`),
 * puts a DIRTY physical state back to AVAILABLE_CLEAN, and stops the room's own cleaning clock
 * (W24). Every change goes through `transitionRoomClaimState`, so it writes a RoomClaimStateEvent,
 * and the act is traced `HOUSEKEEPING.ROOM_CLEANED` with the minutes it took and whether it was in
 * time — the record later monitoring reads.
 *
 * The routes are the desk's today and a housekeeping phone app's later: plain room-level reads and
 * writes, nothing tied to a booking's step.
 */
import { InventoryClaimState, Prisma, RoomPhysicalState, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { findRoomBookingConflicts } from "../../lib/room-booking-conflicts.js";
import { transitionRoomClaimState } from "../../lib/room-claim-state.js";
import { readExpectedRoomFlags } from "../../lib/room-flag-repair.js";
import { hotelLocalTimeOn, hotelTodayUtc } from "../../lib/stay-dates.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";

const W24 = "HOUSEKEEPING_SLA_W24";
export const CLEANED_REASON = "HOUSEKEEPING_CLEANED";
export const NEEDS_CLEANING_REASON = "HOUSEKEEPING_NEEDS_CLEANING";

export type HousekeepingState = "TO_CLEAN" | "OCCUPIED" | "OUT_OF_ORDER" | "READY";

export type HousekeepingRoom = {
  roomId: string;
  roomNumber: string;
  floorNumber: number | null;
  roomTypeName: string | null;
  bedType: string | null;
  state: HousekeepingState;
  claimState: InventoryClaimState;
  physicalState: RoomPhysicalState;
  /** The room's open fault report, when it has one. */
  openFault: { id: string; category: string; description: string } | null;
  /** Set when the room needs cleaning. */
  toClean: null | {
    leftAt: string | null;
    leftBy: { entryId: string; guestName: string | null } | null;
    cleanBy: string | null;
    /** The clock is a real W24 timer (else the time is worked out from the window). */
    clockRunning: boolean;
    overdue: boolean;
    minutesOverdue: number | null;
  };
  /** The next booking that holds the room from today on — the one waiting for the clean. */
  nextGuest: null | {
    entryId: string;
    guestName: string | null;
    arrives: string;
    arrivesToday: boolean;
    expectedArrivalTime: string | null;
    holds: "RESERVED" | "HELD";
  };
};

export type CleanedToday = {
  roomId: string;
  roomNumber: string;
  cleanedAt: string;
  cleanedBy: string;
  cleanedByName: string | null;
  minutesTaken: number | null;
  inTime: boolean | null;
};

function guestNameOfEntry(e: {
  contactPersonName?: string | null;
  inquiry?: { guestProfile?: { firstName?: string | null; lastName?: string | null } | null; callerFirstName?: string | null; callerLastName?: string | null } | null;
} | null): string | null {
  if (!e) return null;
  const g = e.inquiry?.guestProfile;
  const full = [g?.firstName, g?.lastName].filter((v) => v && v.trim()).join(" ").trim();
  if (full) return full;
  const caller = [e.inquiry?.callerFirstName, e.inquiry?.callerLastName].filter((v) => v && v.trim()).join(" ").trim();
  return caller || e.contactPersonName?.trim() || null;
}

async function windowMinutes(prisma: PrismaClient): Promise<number> {
  return Number(await requireActiveConfigValue<number>(prisma, "housekeeping.sla.windowMinutes"));
}

function needsCleaning(r: { currentClaimState: InventoryClaimState; physicalState: RoomPhysicalState }) {
  if (r.currentClaimState === InventoryClaimState.OCCUPIED) return false;
  return r.currentClaimState === InventoryClaimState.DEPARTED_DIRTY || r.physicalState === RoomPhysicalState.DIRTY;
}

/** Every room, as housekeeping reads it — the rooms to clean first (overdue, then a guest due in
 *  today, then the soonest clean-by), then the rest. */
export async function listHousekeepingRooms(prisma: PrismaClient, opts: { now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const today = hotelTodayUtc(now);
  const window = await windowMinutes(prisma);
  const rooms = await prisma.room.findMany({
    where: { isShadowInventory: false },
    select: {
      id: true,
      roomNumber: true,
      floorNumber: true,
      bedType: true,
      currentClaimState: true,
      physicalState: true,
      isDeficient: true,
      roomType: { select: { name: true } },
    },
  });
  const roomIds = rooms.map((r) => r.id);

  const [faults, claims, clocks] = await Promise.all([
    prisma.deficientConditionRecord.findMany({
      where: { roomId: { in: roomIds }, status: { in: ["UNRESOLVED", "DEFICIENT_UNRESOLVED_AT_CHECKOUT"] } as never },
      orderBy: { detectedAt: "desc" },
      select: { id: true, roomId: true, category: true, description: true },
    }),
    findRoomBookingConflicts(prisma, {
      roomIds,
      checkIn: today,
      checkOut: new Date(Date.UTC(today.getUTCFullYear() + 2, 0, 1)),
      excludeEntryId: "",
      ignoreRoomMoves: true,
    }),
    prisma.timerRecord.findMany({
      where: { timerCode: W24, entityId: { in: roomIds }, status: { in: ["SCHEDULED", "FIRED"] } },
      orderBy: { createdAt: "desc" },
      select: { entityId: true, dueAt: true, status: true, createdAt: true },
    }),
  ]);

  // The next guest into each room — the earliest claim from today on.
  const next = new Map<string, (typeof claims)[number]>();
  for (const c of claims) {
    const cur = next.get(c.roomId);
    if (!cur || c.startDate.getTime() < cur.startDate.getTime()) next.set(c.roomId, c);
  }
  const nextEntries = await prisma.entry.findMany({
    where: { id: { in: [...new Set([...next.values()].map((c) => c.entryId))] } },
    select: { id: true, expectedArrivalTime: true, expectedArrivalDayAfter: true },
  });
  // A guest expected the next morning is not arriving on the day their stay starts (2026-10-29).
  const arrivalTime = new Map(nextEntries.map((e) => [e.id, e.expectedArrivalDayAfter ? null : e.expectedArrivalTime]));

  const dirty = rooms.filter(needsCleaning);
  const lastDeparture = new Map<string, { at: Date; entryId: string | null }>();
  for (const r of dirty) {
    const ev = await prisma.roomClaimStateEvent.findFirst({
      where: { roomId: r.id, toState: InventoryClaimState.DEPARTED_DIRTY },
      orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
      select: { effectiveFrom: true, entryId: true },
    });
    if (ev) lastDeparture.set(r.id, { at: ev.effectiveFrom, entryId: ev.entryId });
  }
  const leftEntries = await prisma.entry.findMany({
    where: { id: { in: [...new Set([...lastDeparture.values()].map((d) => d.entryId).filter((x): x is string => !!x))] } },
    select: {
      id: true,
      contactPersonName: true,
      inquiry: { select: { callerFirstName: true, callerLastName: true, guestProfile: { select: { firstName: true, lastName: true } } } },
    },
  });
  const leftName = new Map(leftEntries.map((e) => [e.id, guestNameOfEntry(e)]));

  const out: HousekeepingRoom[] = rooms.map((r) => {
    const fault = faults.find((f) => f.roomId === r.id) ?? null;
    const n = next.get(r.id);
    const toClean = needsCleaning(r);
    let toCleanInfo: HousekeepingRoom["toClean"] = null;
    if (toClean) {
      const dep = lastDeparture.get(r.id) ?? null;
      // The room's own clock: the live one, else the one that fired after this departure.
      const clock =
        clocks.find((t) => t.entityId === r.id && t.status === "SCHEDULED") ??
        clocks.find((t) => t.entityId === r.id && (!dep || t.createdAt.getTime() >= dep.at.getTime() - 60_000)) ??
        null;
      const cleanBy = clock?.dueAt ?? (dep ? new Date(dep.at.getTime() + window * 60_000) : null);
      const overdue = !!cleanBy && cleanBy.getTime() <= now.getTime();
      toCleanInfo = {
        leftAt: dep?.at.toISOString() ?? null,
        leftBy: dep?.entryId ? { entryId: dep.entryId, guestName: leftName.get(dep.entryId) ?? null } : null,
        cleanBy: cleanBy?.toISOString() ?? null,
        clockRunning: clock?.status === "SCHEDULED",
        overdue,
        minutesOverdue: overdue && cleanBy ? Math.floor((now.getTime() - cleanBy.getTime()) / 60_000) : null,
      };
    }
    const state: HousekeepingState = toClean
      ? "TO_CLEAN"
      : r.currentClaimState === InventoryClaimState.OCCUPIED
        ? "OCCUPIED"
        : r.isDeficient || r.physicalState === RoomPhysicalState.UNDER_MAINTENANCE
          ? "OUT_OF_ORDER"
          : "READY";
    return {
      roomId: r.id,
      roomNumber: r.roomNumber,
      floorNumber: r.floorNumber ?? null,
      roomTypeName: r.roomType?.name ?? null,
      bedType: r.bedType ?? null,
      state,
      claimState: r.currentClaimState,
      physicalState: r.physicalState,
      openFault: fault ? { id: fault.id, category: String(fault.category), description: fault.description } : null,
      toClean: toCleanInfo,
      nextGuest: n
        ? {
            entryId: n.entryId,
            guestName: n.guestName,
            arrives: n.startDate.toISOString().slice(0, 10),
            arrivesToday: n.startDate.getTime() <= today.getTime(),
            expectedArrivalTime: arrivalTime.get(n.entryId) ?? null,
            holds: n.source === "RESERVED" ? "RESERVED" : "HELD",
          }
        : null,
    };
  });

  const order = (r: HousekeepingRoom) =>
    r.state !== "TO_CLEAN" ? 9 : r.toClean?.overdue ? 0 : r.nextGuest?.arrivesToday ? 1 : 2;
  out.sort(
    (a, b) =>
      order(a) - order(b) ||
      (a.toClean?.cleanBy ?? "").localeCompare(b.toClean?.cleanBy ?? "") ||
      a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }),
  );

  // What was cleaned today, for the record (and the monitoring to come).
  const startOfToday = hotelLocalTimeOn(today, "00:00"); // the hotel's midnight
  const cleanedEvents = await prisma.traceEvent.findMany({
    where: { eventType: "HOUSEKEEPING.ROOM_CLEANED", timestamp: { gte: startOfToday } },
    orderBy: { timestamp: "desc" },
    take: 200,
    select: { entityId: true, timestamp: true, actorId: true, payload: true },
  });
  const staff = await prisma.staffUser.findMany({
    where: { id: { in: [...new Set(cleanedEvents.map((e) => e.actorId))] } },
    select: { id: true, fullName: true },
  });
  const staffName = new Map(staff.map((s) => [s.id, s.fullName]));
  const cleanedToday: CleanedToday[] = cleanedEvents.map((e) => {
    const p = (e.payload ?? {}) as { roomNumber?: string; minutesTaken?: number | null; inTime?: boolean | null };
    return {
      roomId: e.entityId,
      roomNumber: p.roomNumber ?? rooms.find((r) => r.id === e.entityId)?.roomNumber ?? "?",
      cleanedAt: e.timestamp.toISOString(),
      cleanedBy: e.actorId,
      cleanedByName: staffName.get(e.actorId) ?? null,
      minutesTaken: p.minutesTaken ?? null,
      inTime: p.inTime ?? null,
    };
  });

  const toCleanRooms = out.filter((r) => r.state === "TO_CLEAN");
  return {
    now: now.toISOString(),
    windowMinutes: window,
    counts: {
      toClean: toCleanRooms.length,
      overdue: toCleanRooms.filter((r) => r.toClean?.overdue).length,
      guestDueToday: toCleanRooms.filter((r) => r.nextGuest?.arrivesToday).length,
      occupied: out.filter((r) => r.state === "OCCUPIED").length,
      ready: out.filter((r) => r.state === "READY").length,
      outOfOrder: out.filter((r) => r.state === "OUT_OF_ORDER").length,
    },
    rooms: out,
    cleanedToday,
  };
}

/** Stop the room's own cleaning clock(s) — the job and the record. */
async function stopCleaningClocks(prisma: PrismaClient, roomId: string, actorId: string, why: string) {
  const live = await prisma.timerRecord.findMany({
    where: { timerCode: W24, entityId: roomId, status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
  });
  if (!live.length) return 0;
  try {
    const engine = await getTimerEngine();
    await Promise.all(live.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  } catch {
    // The record is cancelled below either way; the worker skips a cancelled clock.
  }
  await prisma.timerRecord.updateMany({
    where: { id: { in: live.map((t) => t.id) }, status: "SCHEDULED" },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: actorId, cancelledReason: why } as never,
  });
  return live.length;
}

/** Mark a room clean. Refused when the room does not need cleaning. */
export async function markRoomCleaned(
  prisma: PrismaClient,
  roomId: string,
  actor: { actorId: string; actorLevel: string },
  input: { note?: string | null } = {},
) {
  const now = new Date();
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { id: true, roomNumber: true, currentClaimState: true, physicalState: true },
  });
  if (!room) throw new NotFoundError("Room");
  if (!needsCleaning(room)) {
    throw new ValidationError(`Room ${room.roomNumber} does not need cleaning — it is not marked as left by a guest`);
  }
  // Where the flag goes once the room is clean: what its bookings say (the flag repair's rule).
  const today = hotelTodayUtc(now);
  const { expected } = await readExpectedRoomFlags(prisma, [room], today);
  const toState = expected.get(room.id) ?? InventoryClaimState.FREE;

  const dep = await prisma.roomClaimStateEvent.findFirst({
    where: { roomId, toState: InventoryClaimState.DEPARTED_DIRTY },
    orderBy: [{ effectiveFrom: "desc" }, { createdAt: "desc" }],
    select: { effectiveFrom: true, entryId: true },
  });
  // The clock armed for THIS departure (an older one belongs to an earlier guest).
  const clock = await prisma.timerRecord.findFirst({
    where: {
      timerCode: W24,
      entityId: roomId,
      status: { in: ["SCHEDULED", "FIRED"] },
      ...(dep ? { createdAt: { gte: new Date(dep.effectiveFrom.getTime() - 60_000) } } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: { dueAt: true },
  });
  // The history line goes on the booking that left — only while it still exists (2026-10-30): a
  // booking erased afterwards (scripts/delete-booking.ts) left the line naming nobody, and the
  // database refused it, so the room could never be marked clean. Its number stays in the payload.
  const leftBy = dep?.entryId ? await prisma.entry.findUnique({ where: { id: dep.entryId }, select: { id: true } }) : null;
  const window = await windowMinutes(prisma);
  const cleanBy = clock?.dueAt ?? (dep ? new Date(dep.effectiveFrom.getTime() + window * 60_000) : null);
  const minutesTaken = dep ? Math.round((now.getTime() - dep.effectiveFrom.getTime()) / 60_000) : null;
  const inTime = cleanBy ? now.getTime() <= cleanBy.getTime() : null;

  await prisma.$transaction(async (tx) => {
    if (room.currentClaimState === InventoryClaimState.DEPARTED_DIRTY && toState !== InventoryClaimState.DEPARTED_DIRTY) {
      await transitionRoomClaimState(tx, {
        roomId,
        toState,
        actorId: actor.actorId,
        entryId: null,
        reason: CLEANED_REASON,
        onlyFromStates: [InventoryClaimState.DEPARTED_DIRTY],
        now,
      });
    }
    if (room.physicalState === RoomPhysicalState.DIRTY) {
      await tx.room.update({ where: { id: roomId }, data: { physicalState: RoomPhysicalState.AVAILABLE_CLEAN, updatedAt: now } });
    }
    await tx.traceEvent.create({
      data: {
        eventType: "HOUSEKEEPING.ROOM_CLEANED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel as never,
        entityType: "Room",
        entityId: roomId,
        operation: "UPDATE",
        timestamp: now,
        entryId: leftBy?.id ?? null,
        payload: {
          roomNumber: room.roomNumber,
          leftAt: dep?.effectiveFrom.toISOString() ?? null,
          leftByEntryId: dep?.entryId ?? null,
          cleanBy: cleanBy?.toISOString() ?? null,
          minutesTaken,
          inTime,
          fromState: room.currentClaimState,
          toState,
          note: input.note?.trim() || null,
        } as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    });
  });
  const stopped = await stopCleaningClocks(prisma, roomId, actor.actorId, `Room ${room.roomNumber} cleaned`);
  return { roomId, roomNumber: room.roomNumber, toState, minutesTaken, inTime, clocksStopped: stopped };
}

/**
 * Put a room back to "needs cleaning" — a room marked clean by mistake, or found dirty again.
 * Refused while a guest is in it (housekeeping then is a stay-over, not a turnover).
 */
export async function markRoomNeedsCleaning(
  prisma: PrismaClient,
  roomId: string,
  actor: { actorId: string; actorLevel: string },
  input: { reason: string },
) {
  const now = new Date();
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { id: true, roomNumber: true, currentClaimState: true, physicalState: true },
  });
  if (!room) throw new NotFoundError("Room");
  if (!input.reason?.trim()) throw new ValidationError("Say why the room needs cleaning again");
  if (room.currentClaimState === InventoryClaimState.OCCUPIED) {
    throw new ValidationError(`Room ${room.roomNumber} has a guest in it`);
  }
  if (needsCleaning(room)) throw new ValidationError(`Room ${room.roomNumber} is already waiting to be cleaned`);
  await prisma.$transaction(async (tx) => {
    await transitionRoomClaimState(tx, {
      roomId,
      toState: InventoryClaimState.DEPARTED_DIRTY,
      actorId: actor.actorId,
      entryId: null,
      reason: NEEDS_CLEANING_REASON,
      now,
    });
    await tx.traceEvent.create({
      data: {
        eventType: "HOUSEKEEPING.ROOM_NEEDS_CLEANING",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel as never,
        entityType: "Room",
        entityId: roomId,
        operation: "UPDATE",
        timestamp: now,
        payload: { roomNumber: room.roomNumber, fromState: room.currentClaimState, reason: input.reason.trim() },
        createdBy: actor.actorId,
      },
    });
  });
  return { roomId, roomNumber: room.roomNumber, toState: InventoryClaimState.DEPARTED_DIRTY };
}
