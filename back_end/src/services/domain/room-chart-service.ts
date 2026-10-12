/**
 * The house chart — every room, night by night (2026-10-12, operator: "show it like the
 * mockup's Rooms tab ... a row named house booked, as numbers like 3/28 ... it will show all
 * the reservations, and checked in, confirmed or parked in different styles").
 *
 * READ-ONLY. Nothing is chosen here: rooms are picked inside a booking. The chart answers
 * "which rooms are taken on which nights, by whom, and how firmly".
 *
 * WHY THE BACKEND BUILDS IT. What blocks a room is a business rule with a long history — the
 * current reservation only, a closed pass's reservation only while its hold lives, assignment
 * rows that end mid-stay, an early departure that frees the unstayed nights, a no-show that lets
 * go, holds that cover every room of their per-night snapshot, stay extensions that claim the
 * nights after checkout. The S1 search and the hold gates read all of that from
 * `entry-inventory-claim`; this chart reads the SAME helpers and the same queries, so a room the
 * chart paints free is a room the search offers, and the desk invents none of it.
 *
 * ONE CLAIM PER BOOKING PER ROOM-NIGHT, the strongest: a confirmed booking keeps its committed
 * hold row, and a booking can carry a speculative hold beside its committed one — both are the
 * same occupancy, so the weaker is dropped (the S1 engine's rule). Two DIFFERENT bookings on the
 * same room-night are left as they are: the desk draws that as a conflict.
 *
 * WHAT IS ADDED FOR THE CHART ONLY: bookings that have finished their stay (Closed, or at the
 * Closed step) are drawn as "checked out" on the nights they used — history, not a claim. A
 * no-show is not drawn: the guest never came.
 */
import type { EntryStatus, PrismaClient, Stage } from "@prisma/client";
import { ValidationError } from "../../lib/errors.js";
import {
  committedHoldSpans,
  currentReservationOnly,
  keepStandingReservations,
  pendingStayExtensionClaims,
  reservedClaimEndDate,
  reservedEntryRoomsSelect,
  reservedEntrySpans,
} from "../../lib/entry-inventory-claim.js";
import { hotelTodayUtc, ymdUtc } from "../../lib/stay-dates.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const CHART_DEFAULT_NIGHTS = 14;
export const CHART_MAX_NIGHTS = 62;

/**
 * How firmly a room-night is taken, strongest first. The desk styles each one differently:
 *   OVERSTAY       — still in the room after the booked checkout (the room reads OCCUPIED,
 *                    the booking is in house, its nights have run out) — drawn up to tonight
 *   IN_HOUSE       — the guest has checked in (Stay / Check-out)
 *   CHECKED_OUT    — the stay is over (history)
 *   RESERVED       — confirmed (Reserve, Arrival, Check-in); `paymentPending` when the advance is short
 *   HELD           — a committed hold at Set up, not confirmed yet
 *   EXTENSION_HELD — the nights a guest in house is extending into, held while the payment comes in
 *   PROVISIONAL    — a provisional block at Negotiation
 */
export type ChartBarKind = "OVERSTAY" | "IN_HOUSE" | "CHECKED_OUT" | "RESERVED" | "HELD" | "EXTENSION_HELD" | "PROVISIONAL";
const STRENGTH: Record<ChartBarKind, number> = {
  OVERSTAY: 7,
  IN_HOUSE: 6,
  CHECKED_OUT: 5,
  RESERVED: 4,
  HELD: 3,
  EXTENSION_HELD: 2,
  PROVISIONAL: 1,
};

export type RoomChartBar = {
  roomId: string;
  entryId: string;
  /** First night, "YYYY-MM-DD". */
  from: string;
  /** The morning after the last night (exclusive), "YYYY-MM-DD". */
  to: string;
  kind: ChartBarKind;
  /** The booking is parked — a pause; its claim still stands. */
  parked: boolean;
  /** Confirmed with the advance still short. */
  paymentPending: boolean;
  /** When a hold lets go, for HELD / EXTENSION_HELD / PROVISIONAL. */
  holdExpiresAt: string | null;
};

export type RoomChartBooking = {
  entryId: string;
  inquiryId: string;
  stage: Stage;
  status: EntryStatus;
  checkInDate: string | null;
  checkOutDate: string | null;
  guestProfile: { firstName: string | null; lastName: string | null } | null;
  inquiry: {
    callerTitle: string | null;
    callerFirstName: string | null;
    callerLastName: string | null;
    callerPhone: string | null;
    callerEmail: string | null;
  } | null;
  partyName: string | null;
};

export type RoomChartNight = {
  date: string;
  total: number;
  /** Rooms taken that night, any kind — the "House booked" figure. */
  booked: number;
  /** Guests in the room — in house, checked out (past nights) and still in after checkout. */
  inHouse: number;
  reserved: number;
  /** Held, extension-held and provisional together — not confirmed. */
  held: number;
  /** Rooms out of order and not otherwise taken. */
  outOfOrder: number;
  free: number;
};

export type RoomChart = {
  from: string;
  to: string;
  today: string;
  nights: string[];
  roomTypes: Array<{ id: string; code: string; name: string; roomIds: string[]; freePerNight: number[] }>;
  rooms: Array<{
    id: string;
    roomNumber: string;
    floorNumber: number | null;
    roomTypeId: string;
    bedType: string | null;
    physicalState: string;
    currentClaimState: string;
    /** Off sale: blocked, or under maintenance until its deadline — and on which of the window's nights. */
    outOfOrder: { reason: string | null; until: string | null; nights: boolean[] } | null;
    /** A fault reported against the room (the desk tags the number). */
    faultOpen: boolean;
    /** How many of the window's nights the room is taken, any kind. */
    nightsTaken: number;
  }>;
  bookings: RoomChartBooking[];
  bars: RoomChartBar[];
  perNight: RoomChartNight[];
};

function parseDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError("from must be a date (YYYY-MM-DD)");
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new ValidationError("from is not a real date");
  return d;
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);

/** The nights a span covers inside the window, as night indexes. */
function nightIndexes(start: Date, end: Date, from: Date, count: number): number[] {
  const out: number[] = [];
  const first = Math.max(0, Math.round((start.getTime() - from.getTime()) / DAY_MS));
  const last = Math.min(count, Math.round((end.getTime() - from.getTime()) / DAY_MS));
  for (let i = first; i < last; i++) out.push(i);
  return out;
}

const entrySelect = {
  id: true,
  inquiryId: true,
  currentStage: true,
  status: true,
  checkInDate: true,
  checkOutDate: true,
  reservationPaymentPending: true,
  guestProfile: { select: { firstName: true, lastName: true } },
  inquiry: {
    select: {
      callerTitle: true,
      callerFirstName: true,
      callerLastName: true,
      callerPhone: true,
      callerEmail: true,
      travelAgent: { select: { displayName: true } },
      corporateAccount: { select: { displayName: true } },
    },
  },
} as const;

export async function buildRoomChart(
  prisma: PrismaClient,
  input: { from?: string; nights?: number },
): Promise<RoomChart> {
  const todayDate = hotelTodayUtc();
  const from = input.from ? parseDay(input.from) : todayDate;
  const count = Math.max(1, Math.min(CHART_MAX_NIGHTS, Math.round(input.nights ?? CHART_DEFAULT_NIGHTS)));
  const to = addDays(from, count);
  const nights = Array.from({ length: count }, (_, i) => ymdUtc(addDays(from, i)));

  // The rooms the house sells. Shadow inventory is the GM's own and never on the desk's board.
  const rooms = await prisma.room.findMany({
    where: { isShadowInventory: false },
    orderBy: { roomNumber: "asc" },
    select: {
      id: true,
      roomNumber: true,
      floorNumber: true,
      roomTypeId: true,
      bedType: true,
      physicalState: true,
      currentClaimState: true,
      isBlocked: true,
      blockedReason: true,
      isUnderMaintenance: true,
      maintenanceDeadline: true,
      isDeficient: true,
      roomType: { select: { id: true, code: true, name: true } },
    },
  });
  rooms.sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true }));
  const roomIds = new Set(rooms.map((r) => r.id));

  // ---- the claims, read exactly as the S1 search reads them -------------------------------
  const [reservations, committedHolds, speculativeHolds] = await Promise.all([
    prisma.reservation.findMany({
      where: {
        frozenCheckInDate: { lt: to },
        frozenCheckOutDate: { gt: from },
        // Every booking that used or holds its rooms — a finished stay is drawn as history.
        // Cancelled and expired ones let go; a no-show never came.
        entry: { status: { notIn: ["CANCELLED", "EXPIRED"] }, noShowDetermination: { is: null } },
        ...currentReservationOnly,
      },
      select: {
        frozenCheckInDate: true,
        frozenCheckOutDate: true,
        entryId: true,
        segmentId: true,
        entry: { select: { ...entrySelect, ...reservedEntryRoomsSelect } },
      },
    }),
    prisma.committedHold.findMany({
      where: {
        state: { in: ["PLACED", "CONFIRMED"] },
        expiresAt: { gt: new Date() },
        entry: {
          status: { notIn: ["CANCELLED", "EXPIRED", "CLOSED"] },
          noShowDetermination: { is: null },
          checkInDate: { lt: to },
          checkOutDate: { gt: from },
        },
      },
      select: { roomId: true, entryId: true, perNightBreakdown: true, expiresAt: true, entry: { select: entrySelect } },
    }),
    prisma.speculativeHold.findMany({
      where: {
        state: "PLACED",
        expiresAt: { gt: new Date() },
        entry: {
          status: { notIn: ["CANCELLED", "EXPIRED", "CLOSED"] },
          noShowDetermination: { is: null },
          checkInDate: { lt: to },
          checkOutDate: { gt: from },
        },
      },
      select: { roomId: true, entryId: true, perNightBreakdown: true, expiresAt: true, entry: { select: entrySelect } },
    }),
  ]);
  const extensions = await pendingStayExtensionClaims(prisma, { checkIn: from, checkOut: to });

  type EntryRow = {
    id: string;
    inquiryId: string;
    currentStage: Stage;
    status: EntryStatus;
    checkInDate: Date | null;
    checkOutDate: Date | null;
    reservationPaymentPending: boolean;
    guestProfile: { firstName: string | null; lastName: string | null } | null;
    inquiry: {
      callerTitle: string | null;
      callerFirstName: string | null;
      callerLastName: string | null;
      callerPhone: string | null;
      callerEmail: string | null;
      travelAgent: { displayName: string } | null;
      corporateAccount: { displayName: string } | null;
    } | null;
  };
  const entries = new Map<string, EntryRow>();
  const remember = (e: EntryRow | null | undefined) => {
    if (e) entries.set(e.id, e);
  };

  /** A finished stay, an in-house guest, or a confirmed booking — read off the booking's step. */
  const reservedKind = (e: EntryRow): ChartBarKind => {
    if (e.status === "CLOSED" || e.currentStage === "S9" || e.currentStage === "TERMINAL") return "CHECKED_OUT";
    if (e.currentStage === "S7" || e.currentStage === "S8") return "IN_HOUSE";
    return "RESERVED";
  };

  type Claim = { roomId: string; start: Date; end: Date; entryId: string; kind: ChartBarKind; holdExpiresAt: Date | null };
  const claims: Claim[] = [];

  for (const r of await keepStandingReservations(prisma, reservations)) {
    const e = r.entry as unknown as EntryRow & Parameters<typeof reservedEntrySpans>[0];
    remember(e);
    const kind = reservedKind(e);
    for (const s of reservedEntrySpans(e, {
      checkIn: r.frozenCheckInDate,
      checkOut: reservedClaimEndDate(r.frozenCheckOutDate, e),
    })) {
      claims.push({ roomId: s.roomId, start: s.startDate, end: s.endDate, entryId: r.entryId, kind, holdExpiresAt: null });
    }
  }
  for (const h of committedHolds) {
    const e = h.entry as unknown as EntryRow;
    if (!e?.checkInDate || !e.checkOutDate) continue;
    remember(e);
    for (const s of committedHoldSpans(h, { checkIn: e.checkInDate, checkOut: e.checkOutDate })) {
      claims.push({ roomId: s.roomId, start: s.startDate, end: s.endDate, entryId: h.entryId, kind: "HELD", holdExpiresAt: h.expiresAt });
    }
  }
  for (const h of speculativeHolds) {
    const e = h.entry as unknown as EntryRow;
    if (!e?.checkInDate || !e.checkOutDate) continue;
    remember(e);
    for (const s of committedHoldSpans(h, { checkIn: e.checkInDate, checkOut: e.checkOutDate })) {
      claims.push({ roomId: s.roomId, start: s.startDate, end: s.endDate, entryId: h.entryId, kind: "PROVISIONAL", holdExpiresAt: h.expiresAt });
    }
  }
  if (extensions.length > 0) {
    const extEntries = await prisma.entry.findMany({
      where: { id: { in: [...new Set(extensions.map((x) => x.entryId))] } },
      select: entrySelect,
    });
    for (const e of extEntries) remember(e as unknown as EntryRow);
    for (const x of extensions) {
      claims.push({ roomId: x.roomId, start: x.startDate, end: x.endDate, entryId: x.entryId, kind: "EXTENSION_HELD", holdExpiresAt: x.holdExpiresAt });
    }
  }

  /**
   * Still in the room after the booked checkout. The claim helpers answer by DATES, so a guest
   * who should have left yesterday holds nothing tonight — yet the room reads OCCUPIED and
   * nobody can sleep in it. Drawn from the day they were due out up to tonight, so the desk
   * sees it rather than a free room it cannot sell.
   */
  const today = todayDate;
  if (today.getTime() >= from.getTime()) {
    const overdue = await prisma.entry.findMany({
      where: {
        currentStage: { in: ["S7", "S8"] },
        status: { in: ["ACTIVE", "PARKED"] },
        checkOutDate: { lte: addDays(today, 1) },
        roomAssignments: { some: { room: { currentClaimState: "OCCUPIED" } } },
      },
      select: {
        ...entrySelect,
        actualCheckOutDate: true,
        roomAssignments: { select: { roomId: true, endDate: true, room: { select: { currentClaimState: true } } } },
      },
    });
    for (const e of overdue) {
      if (!e.checkOutDate) continue;
      const due = reservedClaimEndDate(e.checkOutDate, e);
      if (due.getTime() > today.getTime()) continue;
      remember(e as unknown as EntryRow);
      const occupied = new Set(
        e.roomAssignments.filter((a) => a.room?.currentClaimState === "OCCUPIED").map((a) => a.roomId),
      );
      for (const roomId of occupied) {
        claims.push({ roomId, start: due, end: addDays(today, 1), entryId: e.id, kind: "OVERSTAY", holdExpiresAt: null });
      }
    }
  }

  // ---- one claim per booking per room-night: the strongest ----------------------------------
  // owner[room][night] = entryId -> its strongest claim that night
  const owner = new Map<string, Map<number, Map<string, Claim>>>();
  for (const c of claims) {
    if (!roomIds.has(c.roomId)) continue;
    const byNight = owner.get(c.roomId) ?? new Map<number, Map<string, Claim>>();
    owner.set(c.roomId, byNight);
    for (const i of nightIndexes(c.start, c.end, from, count)) {
      const byEntry = byNight.get(i) ?? new Map<string, Claim>();
      byNight.set(i, byEntry);
      const cur = byEntry.get(c.entryId);
      if (!cur || STRENGTH[c.kind] > STRENGTH[cur.kind]) byEntry.set(c.entryId, c);
    }
  }

  // ---- bars: consecutive nights of one booking, one kind, on one room ----------------------
  const bars: RoomChartBar[] = [];
  for (const room of rooms) {
    const byNight = owner.get(room.id);
    if (!byNight) continue;
    const entryIds = new Set<string>();
    for (const m of byNight.values()) for (const id of m.keys()) entryIds.add(id);
    for (const entryId of entryIds) {
      let i = 0;
      while (i < count) {
        const c = byNight.get(i)?.get(entryId);
        if (!c) {
          i++;
          continue;
        }
        let j = i;
        while (j + 1 < count && byNight.get(j + 1)?.get(entryId)?.kind === c.kind) j++;
        const e = entries.get(entryId);
        bars.push({
          roomId: room.id,
          entryId,
          from: nights[i],
          to: ymdUtc(addDays(from, j + 1)),
          kind: c.kind,
          parked: e?.status === "PARKED",
          paymentPending: c.kind === "RESERVED" && e?.reservationPaymentPending === true,
          holdExpiresAt: c.holdExpiresAt ? c.holdExpiresAt.toISOString() : null,
        });
        i = j + 1;
      }
    }
  }
  bars.sort((a, b) => a.from.localeCompare(b.from));

  // ---- out of order, and the per-night figures ----------------------------------------------
  const outOfOrderOn = (r: (typeof rooms)[number], i: number): boolean => {
    if (r.isBlocked) return true;
    if (!r.isUnderMaintenance) return false;
    if (!r.maintenanceDeadline) return true;
    // Off sale up to the night the work is due to be finished.
    return addDays(from, i).getTime() < r.maintenanceDeadline.getTime();
  };

  const perNight: RoomChartNight[] = nights.map((date, i) => {
    let booked = 0;
    let inHouse = 0;
    let reserved = 0;
    let held = 0;
    let outOfOrder = 0;
    for (const r of rooms) {
      const taken = [...(owner.get(r.id)?.get(i)?.values() ?? [])];
      if (taken.length === 0) {
        if (outOfOrderOn(r, i)) outOfOrder++;
        continue;
      }
      booked++;
      const top = taken.reduce((a, b) => (STRENGTH[b.kind] > STRENGTH[a.kind] ? b : a));
      if (top.kind === "IN_HOUSE" || top.kind === "CHECKED_OUT" || top.kind === "OVERSTAY") inHouse++;
      else if (top.kind === "RESERVED") reserved++;
      else held++;
    }
    return { date, total: rooms.length, booked, inHouse, reserved, held, outOfOrder, free: rooms.length - booked - outOfOrder };
  });

  const types = new Map<string, { id: string; code: string; name: string; roomIds: string[] }>();
  for (const r of rooms) {
    const t = types.get(r.roomTypeId) ?? { id: r.roomType.id, code: r.roomType.code, name: r.roomType.name, roomIds: [] };
    t.roomIds.push(r.id);
    types.set(r.roomTypeId, t);
  }
  const roomTypes = [...types.values()].map((t) => ({
    ...t,
    freePerNight: nights.map((_, i) =>
      t.roomIds.filter((id) => {
        const r = rooms.find((x) => x.id === id)!;
        return (owner.get(id)?.get(i)?.size ?? 0) === 0 && !outOfOrderOn(r, i);
      }).length,
    ),
  }));

  const usedEntryIds = new Set(bars.map((b) => b.entryId));
  const bookings: RoomChartBooking[] = [...entries.values()]
    .filter((e) => usedEntryIds.has(e.id))
    .map((e) => ({
      entryId: e.id,
      inquiryId: e.inquiryId,
      stage: e.currentStage,
      status: e.status,
      checkInDate: e.checkInDate ? ymdUtc(e.checkInDate) : null,
      checkOutDate: e.checkOutDate ? ymdUtc(e.checkOutDate) : null,
      guestProfile: e.guestProfile,
      inquiry: e.inquiry
        ? {
            callerTitle: e.inquiry.callerTitle,
            callerFirstName: e.inquiry.callerFirstName,
            callerLastName: e.inquiry.callerLastName,
            callerPhone: e.inquiry.callerPhone,
            callerEmail: e.inquiry.callerEmail,
          }
        : null,
      partyName: e.inquiry?.travelAgent?.displayName ?? e.inquiry?.corporateAccount?.displayName ?? null,
    }));

  return {
    from: ymdUtc(from),
    to: ymdUtc(to),
    today: ymdUtc(todayDate),
    nights,
    roomTypes,
    rooms: rooms.map((r) => ({
      id: r.id,
      roomNumber: r.roomNumber,
      floorNumber: r.floorNumber,
      roomTypeId: r.roomTypeId,
      bedType: r.bedType,
      physicalState: r.physicalState,
      currentClaimState: r.currentClaimState,
      outOfOrder:
        r.isBlocked || r.isUnderMaintenance
          ? {
              reason: r.isBlocked ? (r.blockedReason ?? "blocked") : "under maintenance",
              until: r.isUnderMaintenance && r.maintenanceDeadline ? r.maintenanceDeadline.toISOString() : null,
              nights: nights.map((_, i) => outOfOrderOn(r, i)),
            }
          : null,
      faultOpen: r.isDeficient,
      nightsTaken: nights.filter((_, i) => (owner.get(r.id)?.get(i)?.size ?? 0) > 0).length,
    })),
    bookings,
    bars,
    perNight,
  };
}
