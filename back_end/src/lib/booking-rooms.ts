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

/**
 * A booking's rooms seen room by room: every night the booking has in one real room, and whether
 * the system may move them (every one of those nights quiet). A move takes ALL of a booking's
 * nights in a room to one other room of the same type, so it is a plain swap of one room number
 * for another in every record — the price, the guests, the meals and the beds follow unchanged.
 */
export type QuietUnit = { roomId: string; roomTypeId: string; nights: string[]; quiet: boolean };

export function roomUnitsOf(rooms: BookingRoom[]): QuietUnit[] {
  const byRoom = new Map<string, QuietUnit>();
  for (const r of rooms) {
    for (const n of r.nights) {
      if (!n.roomId) continue;
      const u = byRoom.get(n.roomId) ?? { roomId: n.roomId, roomTypeId: n.roomTypeId, nights: [], quiet: true };
      if (!u.nights.includes(n.date)) u.nights.push(n.date);
      if (n.fixed || u.roomTypeId !== n.roomTypeId) u.quiet = false;
      byRoom.set(n.roomId, u);
    }
  }
  for (const u of byRoom.values()) u.nights.sort();
  return [...byRoom.values()];
}

/** Booking rooms with every room relabelled through `map` (old room id → new). */
export function relabelBookingRooms(rooms: BookingRoom[], map: Map<string, string>): BookingRoom[] {
  return rooms.map((r) => ({
    key: r.key,
    nights: r.nights.map((n) => (n.roomId && map.has(n.roomId) ? { ...n, roomId: map.get(n.roomId)! } : n)),
  }));
}

/** Every night of every booking room made fixed to the room it sits in (the desk confirmed them). */
export function fixAllBookingRooms(rooms: BookingRoom[]): BookingRoom[] {
  return rooms.map((r) => ({ key: r.key, nights: r.nights.map((n) => (n.roomId ? { ...n, fixed: true } : n)) }));
}

/**
 * The booking rooms after a pick is sealed again by something other than the by-type pick — a room
 * change, a setup change, a date move, a split, a change of configuration at Negotiation (2026-10-28,
 * operator: "complete the things you haven't finished"). Before this every such re-seal dropped the
 * booking rooms, so the booking read as fixed rooms afterwards and the system stopped moving them.
 *
 * One booking room per room in the new pick, on the nights it is held. A room stays the system's
 * choice (quiet) when it was quiet before and the change did not name it (`chosen`); a room the
 * change brought in, a room it named, and a room that was fixed are fixed. Rooms keep the order of
 * their old booking rooms, so "Deluxe Double · room 2" keeps its number. Null when the old pick had
 * no booking rooms — a pick made by number stays one.
 */
export function carryBookingRooms(
  prior: BookingRoom[] | null,
  picture: Array<{ date: string; roomIds: string[] }>,
  opts: {
    chosen?: Iterable<string>;
    /** Rooms new to the booking that the SYSTEM chose — the desk changed a room's type, not its number (2026-10-29). */
    systemChosen?: Iterable<string>;
    roomTypeOf: (roomId: string) => string | null | undefined;
  },
): BookingRoom[] | null {
  if (!prior) return null;
  const quiet = new Set([...roomUnitsOf(prior).filter((u) => u.quiet).map((u) => u.roomId), ...(opts.systemChosen ?? [])]);
  const chosen = new Set(opts.chosen ?? []);
  const keyOf = new Map<string, number>();
  for (const r of prior) {
    const k = Number(r.key.slice(1)) || 999;
    for (const n of r.nights) if (n.roomId) keyOf.set(n.roomId, Math.min(keyOf.get(n.roomId) ?? Number.MAX_SAFE_INTEGER, k));
  }
  const order: string[] = [];
  const nightsOf = new Map<string, string[]>();
  for (const n of [...picture].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const roomId of n.roomIds) {
      if (!nightsOf.has(roomId)) {
        nightsOf.set(roomId, []);
        order.push(roomId);
      }
      const list = nightsOf.get(roomId)!;
      if (!list.includes(ymd(n.date))) list.push(ymd(n.date));
    }
  }
  // Old rooms in their old order; rooms new to the booking after them, as they first appear.
  const ranked = order.map((id, i) => ({ id, rank: keyOf.get(id) ?? 100_000 + i })).sort((a, b) => a.rank - b.rank);
  const out: BookingRoom[] = [];
  for (const { id } of ranked) {
    const typeId = opts.roomTypeOf(id);
    if (!typeId) continue;
    const fixed = !quiet.has(id) || chosen.has(id);
    out.push({ key: `R${out.length + 1}`, nights: nightsOf.get(id)!.map((date) => ({ date, roomTypeId: typeId, roomId: id, fixed })) });
  }
  return out;
}

/**
 * Booking rooms from "how many of each type, each night" (the Inquiry step's type counts), with
 * `fixed` rooms the desk named. Rooms carry on from one night to the next:
 *   1. a fixed room continues as the same booking room;
 *   2. a booking room continues in the same type while that type still has a place that night;
 *   3. a booking room whose type has no place left takes another type (the guest changes type);
 *   4. any place still left opens a new booking room.
 * `previous` (the booking rooms saved before) keeps keys and quiet rooms where they still fit, so
 * saving the same counts again changes nothing.
 */
export function bookingRoomsFromCounts(input: {
  nights: string[];
  counts: Map<string, Map<string, number>>;
  fixed: Array<{ roomId: string; roomTypeId: string }>;
  previous?: BookingRoom[] | null;
}): BookingRoom[] {
  const rooms = new Map<string, BookingRoom>();
  const keyOrder: string[] = [];
  let nextNo = 1;
  const prevByNight = new Map<string, Map<string, BookingRoomNight>>(); // night -> key -> night
  for (const r of input.previous ?? []) {
    nextNo = Math.max(nextNo, (Number(r.key.replace(/^R/, "")) || 0) + 1);
    for (const n of r.nights) {
      const m = prevByNight.get(n.date) ?? new Map<string, BookingRoomNight>();
      m.set(r.key, n);
      prevByNight.set(n.date, m);
    }
  }
  const usedKeys = new Set<string>((input.previous ?? []).map((r) => r.key));
  const newKey = () => {
    while (usedKeys.has(`R${nextNo}`)) nextNo++;
    const k = `R${nextNo++}`;
    usedKeys.add(k);
    return k;
  };
  const add = (key: string, n: BookingRoomNight) => {
    if (!rooms.has(key)) {
      rooms.set(key, { key, nights: [] });
      keyOrder.push(key);
    }
    rooms.get(key)!.nights.push(n);
  };
  let last = new Map<string, BookingRoomNight>(); // key -> its night yesterday
  for (const date of [...input.nights].sort()) {
    const left = new Map(input.counts.get(date) ?? new Map<string, number>());
    const tonight = new Map<string, BookingRoomNight>();
    const take = (typeId: string) => {
      const c = left.get(typeId) ?? 0;
      if (c <= 0) return false;
      left.set(typeId, c - 1);
      return true;
    };
    // The candidates to continue: yesterday's booking rooms, else (first night) the saved ones.
    const carry = last.size > 0 ? last : (prevByNight.get(date) ?? new Map<string, BookingRoomNight>());
    // 1. fixed rooms
    for (const f of input.fixed) {
      if (!take(f.roomTypeId)) continue;
      const key = [...carry.entries()].find(([k, n]) => n.roomId === f.roomId && n.fixed && !tonight.has(k))?.[0] ?? newKey();
      tonight.set(key, { date, roomTypeId: f.roomTypeId, roomId: f.roomId, fixed: true });
    }
    // 2. quiet rooms continuing in their type
    for (const [key, n] of carry) {
      if (tonight.has(key) || n.fixed) continue;
      if (!take(n.roomTypeId)) continue;
      const saved = prevByNight.get(date)?.get(key);
      const roomId = saved && saved.roomTypeId === n.roomTypeId && !saved.fixed ? saved.roomId : n.roomId;
      tonight.set(key, { date, roomTypeId: n.roomTypeId, roomId, fixed: false });
    }
    // 3. booking rooms whose type has no place left take another type
    for (const [key, n] of carry) {
      if (tonight.has(key)) continue;
      if (n.fixed && input.fixed.some((f) => f.roomId === n.roomId)) continue;
      const typeId = [...left.entries()].find(([, c]) => c > 0)?.[0];
      if (!typeId || !take(typeId)) break;
      tonight.set(key, { date, roomTypeId: typeId, roomId: null, fixed: false });
    }
    // 4. new booking rooms for any place still left
    for (const [typeId, c] of [...left.entries()]) {
      for (let i = 0; i < c; i++) tonight.set(newKey(), { date, roomTypeId: typeId, roomId: null, fixed: false });
      left.set(typeId, 0);
    }
    for (const [key, n] of tonight) add(key, n);
    last = tonight;
  }
  return keyOrder.map((k) => rooms.get(k)!).sort((a, b) => (Number(a.key.slice(1)) || 0) - (Number(b.key.slice(1)) || 0));
}

/** Every string (and object key) that names a room in `map`, swapped for its new room — the
 *  relabel a quiet move makes in a booking's own records. Room ids are uuids, so nothing else
 *  can match. */
export function relabelJson(value: unknown, map: Map<string, string>, roomNumbers?: Map<string, string>): unknown {
  if (typeof value === "string") return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => relabelJson(v, map, roomNumbers));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(src)) out[map.get(k) ?? k] = relabelJson(v, map, roomNumbers);
    // A record that names its room's NUMBER beside its id (a quotation's priced rooms) follows
    // the room too — the id moving and the number staying would print the old room (2026-10-28).
    if (roomNumbers && typeof src.roomId === "string" && map.has(src.roomId) && "roomNumber" in src) {
      out.roomNumber = roomNumbers.get(map.get(src.roomId)!) ?? src.roomNumber;
    }
    return out;
  }
  return value;
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
