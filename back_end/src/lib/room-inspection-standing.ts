import type { Prisma, PrismaClient, RoomInspectionRecord } from "@prisma/client";
import { effectiveCheckOutDate } from "./stay-dates.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Where a booking's room inspections stand — ONE INSPECTION PER ROOM (2026-10-26, operator: "do
 * one inspection per room"; it had been one per booking, filed against whichever room the newest
 * assignment named, so a two-room booking's other room was never looked at).
 *
 * The rooms inspected are the rooms the guest LEAVES AT CHECK-OUT — every room whose stay runs to
 * the checkout morning. A room left mid-stay (a room change, a move on an extension, one room of a
 * party released early) was handed to housekeeping the day it was left, and may hold another guest
 * by check-out, so it is not inspected here.
 *
 * Each room's standing is read the way the S9 closure gate reads it, so the desk, the inspection
 * route and both gates agree:
 * - NOT_RECORDED — no inspection for the room (S8→S9 refuses; S9 closure refuses).
 * - DONE         — inspected, at check-out or after departure.
 * - PUT_OFF      — put off at check-out and still open; completable at S9. `windowEndsAt` is the
 *                  room's W9 clock, and `windowTimerScheduled` says whether the FOM can still close
 *                  the window by hand (the expire route needs that clock).
 * - LAPSED       — put off, and the window closed with nothing recorded (W9 fired, or the FOM).
 */
export type RoomInspectionStanding =
  | { state: "NOT_RECORDED"; inspection: null }
  | { state: "DONE"; inspection: RoomInspectionRecord }
  | { state: "PUT_OFF"; inspection: RoomInspectionRecord; windowEndsAt: Date | null; windowTimerScheduled: boolean }
  | { state: "LAPSED"; inspection: RoomInspectionRecord; lapsedAt: Date };

export type RoomToInspect = { roomId: string; roomNumber: string };
export type RoomInspectionRow = RoomToInspect & { standing: RoomInspectionStanding };

export type BookingInspectionStanding = {
  rooms: RoomInspectionRow[];
  /** Every room inspected or put off — what the move to Closed needs. */
  allRecorded: boolean;
  /** Every room inspected, or its window closed — what sealing the booking needs. */
  allResolved: boolean;
  /** The booking in one word: NOT_RECORDED while any room has none, PUT_OFF while any is put off,
   *  LAPSED when all are settled and one lapsed, else DONE. */
  state: RoomInspectionStanding["state"];
};

const W9 = "POST_CHECKOUT_INSPECTION_W9";
const LAPSE_EVENT = "POST_CHECKOUT_INSPECTION.WINDOW_EXPIRED";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** The rooms the guest leaves at check-out, in room-number order. Every room the booking ever
 *  held when none of its rows reach the checkout (a fallback that never hides a room). */
export async function roomsToInspect(db: DbClient, entryId: string): Promise<RoomToInspect[]> {
  const entry = await db.entry.findUnique({
    where: { id: entryId },
    select: {
      checkInDate: true,
      checkOutDate: true,
      actualCheckOutDate: true,
      reservation: { select: { frozenCheckInDate: true, frozenCheckOutDate: true } },
      roomAssignments: { select: { roomId: true, endDate: true, room: { select: { roomNumber: true } } } },
    },
  });
  if (!entry) return [];
  const checkout = effectiveCheckOutDate(entry);
  const byRoom = new Map<string, { roomNumber: string; reachesCheckout: boolean }>();
  for (const a of entry.roomAssignments) {
    // A row with no end runs to checkout; a dated row reaches it when it ends on (or after) the
    // checkout morning — its end is the exclusive move-out morning.
    const reaches = !a.endDate || !checkout || ymd(a.endDate) >= ymd(checkout);
    const prior = byRoom.get(a.roomId);
    byRoom.set(a.roomId, { roomNumber: a.room.roomNumber, reachesCheckout: (prior?.reachesCheckout ?? false) || reaches });
  }
  const all = [...byRoom.entries()].map(([roomId, r]) => ({ roomId, roomNumber: r.roomNumber, reaches: r.reachesCheckout }));
  const atCheckout = all.filter((r) => r.reaches);
  return (atCheckout.length ? atCheckout : all)
    .map(({ roomId, roomNumber }) => ({ roomId, roomNumber }))
    .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
}

/** The room's live W9 clock(s), newest first. A clock written before 2026-10-26 names its room in
 *  its payload too (it always did). */
export async function scheduledInspectionTimers(db: DbClient, entryId: string, roomId: string) {
  return db.timerRecord.findMany({
    where: { entryId, timerCode: W9, status: "SCHEDULED", payload: { path: ["roomId"], equals: roomId } },
    orderBy: { createdAt: "desc" },
  });
}

/** One room's standing. A lapse written before 2026-10-26 names no room — it came from the
 *  one-inspection-per-booking days, so it settles every room. */
export async function readRoomInspectionStandingForRoom(db: DbClient, entryId: string, roomId: string): Promise<RoomInspectionStanding> {
  const latest = await db.roomInspectionRecord.findFirst({ where: { entryId, roomId }, orderBy: { createdAt: "desc" } });
  if (!latest) return { state: "NOT_RECORDED", inspection: null };
  // The room's NEWEST record stands: a completion after departure is a newer record than the
  // put-off it finishes, and a room recorded again at check-out as put off is put off.
  if (!latest.isDeferred) return { state: "DONE", inspection: latest };

  const lapses = await db.traceEvent.findMany({
    where: { entryId, eventType: LAPSE_EVENT },
    orderBy: { timestamp: "desc" },
    select: { timestamp: true, payload: true },
  });
  const lapse = lapses.find((t) => {
    const named = (t.payload as { roomId?: string | null } | null)?.roomId;
    return !named || named === roomId;
  });
  // A lapse closes the put-off it followed; a newer put-off of the same room opens a new window.
  if (lapse && lapse.timestamp >= latest.createdAt) return { state: "LAPSED", inspection: latest, lapsedAt: lapse.timestamp };

  const [timer] = await scheduledInspectionTimers(db, entryId, roomId);
  return { state: "PUT_OFF", inspection: latest, windowEndsAt: timer?.dueAt ?? null, windowTimerScheduled: !!timer };
}

export async function readBookingInspectionStanding(db: DbClient, entryId: string): Promise<BookingInspectionStanding> {
  const list = await roomsToInspect(db, entryId);
  const rooms: RoomInspectionRow[] = [];
  for (const r of list) rooms.push({ ...r, standing: await readRoomInspectionStandingForRoom(db, entryId, r.roomId) });
  const states = rooms.map((r) => r.standing.state);
  const allRecorded = rooms.length > 0 && states.every((s) => s !== "NOT_RECORDED");
  const allResolved = rooms.length > 0 && states.every((s) => s === "DONE" || s === "LAPSED");
  const state: RoomInspectionStanding["state"] = !allRecorded
    ? "NOT_RECORDED"
    : states.includes("PUT_OFF")
      ? "PUT_OFF"
      : states.includes("LAPSED")
        ? "LAPSED"
        : "DONE";
  return { rooms, allRecorded, allResolved, state };
}

/** One room's inspection as the desk reads it — the same view on the Check-out step (the
 *  inspection list) and the Closed step (closure readiness). `openFault` is the room's open fault
 *  report, which the inspection must answer. */
export type RoomInspectionView = {
  roomId: string;
  roomNumber: string;
  state: RoomInspectionStanding["state"];
  inspectionId: string | null;
  inspectedAt: Date | null;
  isDeferred: boolean;
  deficientFlagStatus: string | null;
  inspectorAssessment: string | null;
  damageFound: boolean;
  damageNotes: string | null;
  /** How the damage was answered (2026-10-26): CHARGED · WAIVED · LATER, null while unanswered. */
  damageAnswer: string | null;
  damageFaultId: string | null;
  windowEndsAt: Date | null;
  windowCanBeClosed: boolean;
  lapsedAt: Date | null;
  openFault: { id: string; category: string; description: string } | null;
};

export async function describeBookingInspections(db: DbClient, entryId: string) {
  const standing = await readBookingInspectionStanding(db, entryId);
  const rooms: RoomInspectionView[] = [];
  for (const r of standing.rooms) {
    const s = r.standing;
    const insp = s.inspection;
    const fault = await db.deficientConditionRecord.findFirst({
      where: { roomId: r.roomId, status: { in: ["UNRESOLVED", "DEFICIENT_UNRESOLVED_AT_CHECKOUT"] } as never },
      orderBy: { detectedAt: "desc" },
      select: { id: true, category: true, description: true },
    });
    rooms.push({
      roomId: r.roomId,
      roomNumber: r.roomNumber,
      state: s.state,
      inspectionId: insp?.id ?? null,
      inspectedAt: insp?.inspectedAt ?? null,
      isDeferred: insp?.isDeferred ?? false,
      deficientFlagStatus: insp?.deficientFlagStatus ?? null,
      inspectorAssessment: insp?.inspectorAssessment ?? null,
      damageFound: insp?.damageFound ?? false,
      damageNotes: insp?.damageNotes ?? null,
      damageAnswer: insp && !insp.isDeferred && insp.damageFound ? insp.damageAnswer : null,
      damageFaultId: insp?.damageFaultId ?? null,
      windowEndsAt: s.state === "PUT_OFF" ? s.windowEndsAt : null,
      windowCanBeClosed: s.state === "PUT_OFF" && s.windowTimerScheduled,
      lapsedAt: s.state === "LAPSED" ? s.lapsedAt : null,
      openFault: fault ? { id: fault.id, category: String(fault.category), description: fault.description } : null,
    });
  }
  return {
    state: standing.state,
    allRecorded: standing.allRecorded,
    allResolved: standing.allResolved,
    inspectedCount: rooms.filter((r) => r.state !== "NOT_RECORDED").length,
    rooms,
  };
}

/** "Room 201", "Rooms 201 and 202", "Rooms 201, 202 and 203". */
export function roomListWords(numbers: string[]): string {
  if (numbers.length === 0) return "";
  if (numbers.length === 1) return `Room ${numbers[0]}`;
  return `Rooms ${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
}
