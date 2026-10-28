/**
 * A booking's rooms, numbered — "room 1, room 2" — each with a room type for every night
 * (2026-10-28, docs/room-types-until-arrival.md, operator: "choose the number of room types per
 * date in stage one to stage four, since we assign rooms in stage five").
 *
 * WHAT A BOOKING ROOM IS. Everything the desk sets for a room — who sleeps in it, its meal plan,
 * extra beds, negotiated rate, bed setup — belongs to the booking room ("room 1"), never to a room
 * number. Each night of a booking room says:
 *   - `roomTypeId` — the type booked that night (a type may change between nights);
 *   - `roomId` — the real room it sits in that night;
 *   - `fixed` — true when that room is the desk's or the guest's choice ("they always want 305"),
 *     which the system never moves; false when the system chose it quietly, and may move it to
 *     another room of the same type until Arrival.
 *
 * WHERE IT LIVES. On the sealed selection (`AvailabilityConfiguration.optionSelected`), beside the
 * per-night room list every other reader already uses: `bookingRooms` says what each room-night is,
 * `perNight` stays the plain list of the rooms held each night, written from it, so the search, the
 * holds, the chart and the price keep reading what they read today.
 *
 * A SEAL FROM BEFORE BOOKING ROOMS reads as FIXED rooms — one booking room per distinct room, on the
 * nights it appears (operator ruling: bookings already at Negotiation, Set up or Reserve keep their
 * rooms, so nothing moves under anyone).
 */
import { sealAsPerNight } from "./option-selected-reader.js";

export type BookingRoomNight = {
  /** "YYYY-MM-DD" — the night. */
  date: string;
  roomTypeId: string;
  /** The real room that night; null while none is chosen yet. */
  roomId: string | null;
  /** The desk's or the guest's room — never moved by the system. */
  fixed: boolean;
};

export type BookingRoom = {
  /** "R1", "R2" … — stable for the booking's life; what the price table and the beds are keyed by. */
  key: string;
  nights: BookingRoomNight[];
};

/** Consecutive nights of one booking room that must be one real room. */
export type BookingRoomRun = {
  key: string;
  roomTypeId: string;
  /** The nights, in order, "YYYY-MM-DD". */
  nights: string[];
  /** The room these nights sit in (the fixed room, or the quiet one). */
  roomId: string | null;
  fixed: boolean;
};

const DAY_MS = 86_400_000;
const ymd = (d: string) => d.slice(0, 10);
const nextDay = (d: string) => new Date(Date.parse(`${ymd(d)}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);

function parseBookingRooms(raw: unknown): BookingRoom[] | null {
  if (!Array.isArray(raw)) return null;
  const out: BookingRoom[] = [];
  for (const r of raw) {
    const x = r as { key?: unknown; nights?: unknown } | null;
    if (typeof x?.key !== "string" || !Array.isArray(x.nights)) return null;
    const nights: BookingRoomNight[] = [];
    for (const n of x.nights as unknown[]) {
      const y = n as { date?: unknown; roomTypeId?: unknown; roomId?: unknown; fixed?: unknown } | null;
      if (typeof y?.date !== "string" || typeof y.roomTypeId !== "string") return null;
      nights.push({
        date: ymd(y.date),
        roomTypeId: y.roomTypeId,
        roomId: typeof y.roomId === "string" ? y.roomId : null,
        fixed: y.fixed === true && typeof y.roomId === "string",
      });
    }
    nights.sort((a, b) => a.date.localeCompare(b.date));
    out.push({ key: x.key, nights });
  }
  return out;
}

/** Was this seal written with booking rooms? (An older seal reads as fixed rooms.) */
export function sealHasBookingRooms(opt: unknown): boolean {
  return !!opt && typeof opt === "object" && !Array.isArray(opt) && parseBookingRooms((opt as Record<string, unknown>).bookingRooms) !== null;
}

/**
 * The booking rooms a seal names. A seal written with booking rooms is read as it is; any other
 * seal reads as fixed rooms, one booking room per distinct room, in the order the rooms first
 * appear. `roomTypeOf` gives a room's type; a room it does not know is left out (a room since
 * removed from the house has no type to book).
 */
export function readBookingRooms(
  opt: unknown,
  stay: { checkIn: Date | null | undefined; checkOut: Date | null | undefined },
  roomTypeOf: (roomId: string) => string | null | undefined,
): BookingRoom[] {
  if (opt && typeof opt === "object" && !Array.isArray(opt)) {
    const parsed = parseBookingRooms((opt as Record<string, unknown>).bookingRooms);
    if (parsed) return parsed;
  }
  const seal = sealAsPerNight(opt, stay);
  if (!seal) return [];
  const order: string[] = [];
  const nightsOf = new Map<string, string[]>();
  for (const n of [...seal].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const r of n.roomIds) {
      if (!nightsOf.has(r.roomId)) {
        nightsOf.set(r.roomId, []);
        order.push(r.roomId);
      }
      const list = nightsOf.get(r.roomId)!;
      if (!list.includes(n.date)) list.push(n.date);
    }
  }
  const rooms: BookingRoom[] = [];
  for (const roomId of order) {
    const typeId = roomTypeOf(roomId);
    if (!typeId) continue;
    rooms.push({
      key: `R${rooms.length + 1}`,
      nights: nightsOf.get(roomId)!.map((date) => ({ date, roomTypeId: typeId, roomId, fixed: true })),
    });
  }
  return rooms;
}

/**
 * Cut a booking room into runs that must each be ONE real room: consecutive nights of the same
 * type, all quiet or all fixed to the same room. A change of type, a gap, or a fixed room that
 * changes between nights starts a new run.
 */
export function bookingRoomRuns(room: BookingRoom): BookingRoomRun[] {
  const runs: BookingRoomRun[] = [];
  let cur: BookingRoomRun | null = null;
  let prevDate: string | null = null;
  for (const n of [...room.nights].sort((a, b) => a.date.localeCompare(b.date))) {
    const continues =
      cur &&
      prevDate !== null &&
      nextDay(prevDate) === n.date &&
      cur.roomTypeId === n.roomTypeId &&
      cur.fixed === n.fixed &&
      (!n.fixed || cur.roomId === n.roomId);
    if (cur && continues) {
      cur.nights.push(n.date);
      // A quiet run sits in one room; the first night's room speaks for it.
      if (!cur.fixed && cur.roomId == null) cur.roomId = n.roomId;
    } else {
      cur = { key: room.key, roomTypeId: n.roomTypeId, nights: [n.date], roomId: n.roomId, fixed: n.fixed };
      runs.push(cur);
    }
    prevDate = n.date;
  }
  return runs;
}

/** How many rooms of each type the booking asks for, night by night. */
export function typeCountsPerNight(rooms: BookingRoom[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const r of rooms) {
    for (const n of r.nights) {
      const m = out.get(n.date) ?? new Map<string, number>();
      m.set(n.roomTypeId, (m.get(n.roomTypeId) ?? 0) + 1);
      out.set(n.date, m);
    }
  }
  return out;
}

/**
 * The seal for a set of booking rooms: `bookingRooms` as they are, and `perNight` — the rooms held
 * each night — written from them for every reader of the plain list. A night with no room chosen
 * yet is in `bookingRooms` only.
 */
export function sealFromBookingRooms(
  rooms: BookingRoom[],
  opts?: { deficientRoomIds?: Iterable<string> },
): { bookingRooms: BookingRoom[]; perNight: Array<{ date: string; roomIds: Array<{ roomId: string; isDeficient: boolean }> }>; isDeficient: boolean } {
  const deficient = new Set(opts?.deficientRoomIds ?? []);
  const byNight = new Map<string, Array<{ roomId: string; isDeficient: boolean }>>();
  for (const r of rooms) {
    for (const n of r.nights) {
      if (!n.roomId) continue;
      const list = byNight.get(n.date) ?? [];
      if (!list.some((x) => x.roomId === n.roomId)) list.push({ roomId: n.roomId, isDeficient: deficient.has(n.roomId) });
      byNight.set(n.date, list);
    }
  }
  const perNight = [...byNight.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, roomIds]) => ({ date, roomIds }));
  return {
    bookingRooms: rooms.map((r) => ({ key: r.key, nights: [...r.nights].sort((a, b) => a.date.localeCompare(b.date)) })),
    perNight,
    isDeficient: perNight.some((n) => n.roomIds.some((x) => x.isDeficient)),
  };
}
