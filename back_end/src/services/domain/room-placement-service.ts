/**
 * The house by room type, night by night — and whether a booking's rooms fit with one room for each
 * guest's whole stay (2026-10-28, stage 1 of docs/room-types-until-arrival.md).
 *
 * READ-ONLY. Nothing is held, moved or written here; the stages that follow build on this answer.
 *
 * THE HOUSE IS THE CHART'S. The claims are read through `buildRoomChart`, which reads them exactly
 * as the S1 search and the hold gates do (reservations, committed and provisional holds, stay
 * extensions, room moves, guests still in after checkout), so a room this answer calls free is a
 * room the chart paints free. The asking booking's own claims are left out — it is asking about
 * itself. Shadow inventory is not counted (the chart leaves it out); a room with an open fault
 * report counts as the chart counts it.
 *
 * FIXED AND QUIET. Every room another booking holds is FIXED — the system may not touch it — unless
 * that booking is still before Arrival and its seal was written with booking rooms whose room the
 * system chose quietly; those stays may move to another room of the same type to let a booking fit.
 * A seal from before booking rooms has no quiet rooms, so today every claim is fixed and the answer
 * is exactly the chart's (ruling 2026-10-28: bookings already at Negotiation, Set up or Reserve keep
 * their rooms).
 */
import type { PrismaClient, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { addUtcDays, listNightYmdsUtc, nightsBetweenUtc, utcDateOnly, ymdUtc } from "../../lib/stay-dates.js";
import {
  bookingRoomRuns,
  readBookingRooms,
  roomUnitsOf,
  sealHasBookingRooms,
  type BookingRoom,
  type BookingRoomRun,
  type QuietUnit,
} from "../../lib/booking-rooms.js";
import { maxExtraStays, placeStays, roomsFreeEveryNight, type PlacementItem } from "../../lib/room-placement.js";
import { buildRoomChart, CHART_MAX_NIGHTS, type RoomChart } from "./room-chart-service.js";

const QUIET_KINDS = new Set(["HELD", "PROVISIONAL", "RESERVED"]);
const BEFORE_ARRIVAL: Stage[] = ["S1", "S2", "S3", "S4", "S5"];

const dayLabel = (ymd: string) =>
  new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const nextYmd = (ymd: string) => ymdUtc(addUtcDays(new Date(`${ymd}T00:00:00.000Z`), 1));
/** "1 Dec → 3 Dec": the first night to the morning after the last. */
const spanWords = (nights: string[]) => `${dayLabel(nights[0])} → ${dayLabel(nextYmd(nights[nights.length - 1]))}`;

export type WorldItem = PlacementItem & { entryId: string; roomTypeId: string; quiet: boolean };

export type World = {
  chart: RoomChart;
  /** "YYYY-MM-DD" → night index in the chart's window. */
  index: Map<string, number>;
  roomTypeOf: Map<string, string>;
  roomNumberOf: Map<string, string>;
  typeName: Map<string, string>;
  /** room → nights out of order (window indexes). */
  unusable: Map<string, Set<number>>;
  items: WorldItem[];
  bookingName: Map<string, string>;
};

/** The pass's own sealed pick — an earlier pass's seal is history (the chart's rule). */
export function currentPassSeal(e: {
  segments: Array<{ id: string }>;
  availabilityConfigs: Array<{ segmentId: string | null; optionSelected: unknown }>;
}): unknown {
  const seg = e.segments[0]?.id ?? null;
  return e.availabilityConfigs.find((c) => c.optionSelected != null && (seg == null || c.segmentId == null || c.segmentId === seg))?.optionSelected ?? null;
}

export const sealSelect = {
  segments: { orderBy: { segmentNumber: "desc" as const }, take: 1, select: { id: true } },
  availabilityConfigs: {
    where: { sealedAt: { not: null } },
    orderBy: { sealedAt: "desc" as const },
    take: 3,
    select: { segmentId: true, optionSelected: true },
  },
};

export async function buildWorld(prisma: PrismaClient, input: { from: Date; to: Date; excludeEntryId: string }): Promise<World> {
  let from = input.from;
  let to = input.to;
  for (let pass = 0; ; pass++) {
    const count = nightsBetweenUtc(from, to);
    if (count > CHART_MAX_NIGHTS) throw new ValidationError(`A stay of more than ${CHART_MAX_NIGHTS} nights cannot be checked here`);
    const chart = await buildRoomChart(prisma, { from: ymdUtc(from), nights: count });
    // A room with an open fault report is tried last: the system never chooses one quietly
    // when a sound room of the type is free.
    const faulty = new Set(chart.rooms.filter((r) => r.faultOpen).map((r) => r.id));
    for (const t of chart.roomTypes) t.roomIds = [...t.roomIds.filter((id) => !faulty.has(id)), ...t.roomIds.filter((id) => faulty.has(id))];
    const index = new Map(chart.nights.map((d, i) => [d, i] as const));
    const roomTypeOf = new Map(chart.rooms.map((r) => [r.id, r.roomTypeId] as const));
    const roomNumberOf = new Map(chart.rooms.map((r) => [r.id, r.roomNumber] as const));
    const typeName = new Map(chart.roomTypes.map((t) => [t.id, t.name] as const));
    const unusable = new Map<string, Set<number>>();
    for (const r of chart.rooms) {
      const off = new Set<number>();
      r.outOfOrder?.nights.forEach((o, i) => o && off.add(i));
      if (off.size > 0) unusable.set(r.id, off);
    }
    const bars = chart.bars.filter((b) => b.entryId !== input.excludeEntryId);

    // cells[entry|room] = the window nights that booking holds on that room
    const cells = new Map<string, Set<number>>();
    for (const b of bars) {
      const key = `${b.entryId}|${b.roomId}`;
      const set = cells.get(key) ?? new Set<number>();
      for (let d = b.from; d < b.to; d = nextYmd(d)) {
        const i = index.get(d);
        if (i !== undefined) set.add(i);
      }
      cells.set(key, set);
    }

    // ---- quiet rooms of bookings not yet given their rooms -----------------------------------
    // A booking's room is the system's to move while the booking is before its rooms are handed
    // out at Arrival (no room assigned yet), no room move is running on it, and its seal says the
    // system chose that room (every night of it quiet).
    const candidateIds = [...new Set(bars.filter((b) => QUIET_KINDS.has(b.kind)).map((b) => b.entryId))];
    const candidates = candidateIds.length
      ? await prisma.entry.findMany({
          where: {
            id: { in: candidateIds },
            currentStage: { in: BEFORE_ARRIVAL },
            status: { in: ["ACTIVE", "PARKED"] },
            roomAssignments: { none: {} },
            roomMoveLegs: { none: { move: { status: { in: ["IN_PROGRESS", "PARTIAL"] } } } },
          },
          select: { id: true, checkInDate: true, checkOutDate: true, ...sealSelect },
        })
      : [];
    const quietUnits: Array<{ entryId: string; unit: QuietUnit }> = [];
    for (const e of candidates) {
      const seal = currentPassSeal(e);
      if (!sealHasBookingRooms(seal)) continue;
      const rooms = readBookingRooms(seal, { checkIn: e.checkInDate, checkOut: e.checkOutDate }, (id) => roomTypeOf.get(id));
      for (const unit of roomUnitsOf(rooms)) if (unit.quiet) quietUnits.push({ entryId: e.id, unit });
    }
    // A quiet room reaching past the window: widen it once so the room can be weighed whole.
    if (pass === 0 && quietUnits.length > 0) {
      const first = quietUnits.reduce((m, q) => (q.unit.nights[0] < m ? q.unit.nights[0] : m), ymdUtc(from));
      const last = quietUnits.reduce((m, q) => {
        const end = nextYmd(q.unit.nights[q.unit.nights.length - 1]);
        return end > m ? end : m;
      }, ymdUtc(to));
      const wFrom = new Date(`${first}T00:00:00.000Z`);
      const wTo = new Date(`${last}T00:00:00.000Z`);
      if ((wFrom < from || wTo > to) && nightsBetweenUtc(wFrom, wTo) <= CHART_MAX_NIGHTS) {
        from = wFrom;
        to = wTo;
        continue;
      }
    }

    const items: WorldItem[] = [];
    for (const { entryId, unit } of quietUnits) {
      const idx = unit.nights.map((d) => index.get(d));
      const held = cells.get(`${entryId}|${unit.roomId}`);
      // Movable only when the room's nights lie inside the window and the booking holds it on every one.
      if (idx.some((i) => i === undefined) || !held || idx.some((i) => !held.has(i!))) continue;
      if (roomTypeOf.get(unit.roomId) !== unit.roomTypeId) continue;
      for (const i of idx) held.delete(i!);
      items.push({
        id: `${entryId}|unit|${unit.roomId}`,
        entryId,
        roomTypeId: unit.roomTypeId,
        nights: idx as number[],
        fixedRoomId: null,
        currentRoomId: unit.roomId,
        quiet: true,
      });
    }
    // ---- everything else another booking holds is fixed --------------------------------------
    for (const [key, set] of cells) {
      const [entryId, roomId] = key.split("|");
      const typeId = roomTypeOf.get(roomId);
      if (!typeId || set.size === 0) continue;
      const ns = [...set].sort((a, b) => a - b);
      let start = 0;
      for (let k = 1; k <= ns.length; k++) {
        if (k < ns.length && ns[k] === ns[k - 1] + 1) continue;
        items.push({
          id: `${entryId}|${roomId}|${ns[start]}`,
          entryId,
          roomTypeId: typeId,
          nights: ns.slice(start, k),
          fixedRoomId: roomId,
          currentRoomId: roomId,
          quiet: false,
        });
        start = k;
      }
    }

    const bookingName = new Map<string, string>();
    for (const b of chart.bookings) {
      const guest = [b.guestProfile?.firstName, b.guestProfile?.lastName].filter(Boolean).join(" ");
      const caller = [b.inquiry?.callerFirstName, b.inquiry?.callerLastName].filter(Boolean).join(" ");
      bookingName.set(b.entryId, `${guest || caller || b.partyName || "a booking"} (${b.entryId})`);
    }
    return { chart, index, roomTypeOf, roomNumberOf, typeName, unusable, items, bookingName };
  }
}

export type HouseTypeAnswer = {
  roomTypeId: string;
  code: string;
  name: string;
  rooms: number;
  perNight: Array<{ date: string; usable: number; taken: number; free: number }>;
  /** Rooms free on every night of the stay, everything left where it is. */
  freeEveryNight: number;
  /** Whole stays (one room for all the nights) the type can still take, quiet rooms re-placed. */
  wholeStay: number;
  /** The search ran out of steps — `wholeStay` may be low. */
  wholeStayUncertain: boolean;
  /** Stays of other bookings the system may move within this type. */
  quietStays: number;
};

export type BookingRunAnswer = {
  roomTypeId: string;
  typeName: string;
  nights: string[];
  /** In words: "1 Dec → 3 Dec". */
  span: string;
  fixed: boolean;
  /** The room on record (the fixed room, or the quiet one), if any. */
  roomId: string | null;
  roomNumber: string | null;
  /** Where the check would put it. */
  placedRoomId: string | null;
  placedRoomNumber: string | null;
};

export type BookingRoomsAnswer = {
  /** Read from the booking's sealed pick, or sent to be checked. */
  source: "SEAL" | "PROPOSED";
  /** True when the seal predates booking rooms — every room reads as fixed. */
  readAsFixed: boolean;
  fits: boolean;
  refusals: string[];
  rooms: Array<{ key: string; runs: BookingRunAnswer[] }>;
  /** Quiet rooms of other bookings the fit would move. */
  moves: Array<{ entryId: string; booking: string; fromRoomId: string; toRoomId: string; fromRoomNumber: string; toRoomNumber: string; span: string }>;
};

export type HouseByTypeAnswer = {
  entryId: string;
  checkInDate: string;
  checkOutDate: string;
  nights: string[];
  types: HouseTypeAnswer[];
  booking: BookingRoomsAnswer | null;
};

function parseYmd(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError(`${field} must be a date (YYYY-MM-DD)`);
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${field} is not a real date`);
  return d;
}

/**
 * The house by room type over a booking's stay, and — when it has rooms picked, or rooms are sent —
 * whether they fit with one room for each guest's whole stay (each change of type its own stay).
 */
export async function answerHouseByType(
  prisma: PrismaClient,
  entryId: string,
  input: { checkInDate?: string; checkOutDate?: string; bookingRooms?: BookingRoom[] } = {},
): Promise<HouseByTypeAnswer> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { id: true, checkInDate: true, checkOutDate: true, ...sealSelect },
  });
  if (!entry) throw new NotFoundError("Entry");
  const checkIn = input.checkInDate ? parseYmd(input.checkInDate, "checkInDate") : entry.checkInDate ? utcDateOnly(entry.checkInDate) : null;
  const checkOut = input.checkOutDate ? parseYmd(input.checkOutDate, "checkOutDate") : entry.checkOutDate ? utcDateOnly(entry.checkOutDate) : null;
  if (!checkIn || !checkOut) throw new ValidationError("The booking has no stay dates yet");
  if (checkOut <= checkIn) throw new ValidationError("Check-out must be after check-in");

  const world = await buildWorld(prisma, { from: checkIn, to: checkOut, excludeEntryId: entryId });
  const stayNights = listNightYmdsUtc(checkIn, checkOut);
  const stayIdx = stayNights.map((d) => world.index.get(d)!);

  const itemsOfType = (typeId: string) => world.items.filter((it) => it.roomTypeId === typeId);
  const types: HouseTypeAnswer[] = world.chart.roomTypes.map((t) => {
    const items = itemsOfType(t.id);
    const taken = new Set<string>();
    for (const it of items) for (const n of it.nights) taken.add(`${it.fixedRoomId ?? it.currentRoomId}|${n}`);
    const placement = { roomIds: t.roomIds, unusable: world.unusable, items };
    const extra = maxExtraStays(placement, stayIdx);
    return {
      roomTypeId: t.id,
      code: t.code,
      name: t.name,
      rooms: t.roomIds.length,
      perNight: stayNights.map((date, k) => {
        const n = stayIdx[k];
        const usable = t.roomIds.filter((r) => !world.unusable.get(r)?.has(n)).length;
        const takenCount = t.roomIds.filter((r) => taken.has(`${r}|${n}`)).length;
        const free = t.roomIds.filter((r) => !world.unusable.get(r)?.has(n) && !taken.has(`${r}|${n}`)).length;
        return { date, usable, taken: takenCount, free };
      }),
      freeEveryNight: roomsFreeEveryNight(placement, stayIdx).length,
      wholeStay: extra.count,
      wholeStayUncertain: extra.gaveUp,
      quietStays: items.filter((it) => it.quiet).length,
    };
  });

  // ---- the booking's own rooms -------------------------------------------------------------------
  const seal = currentPassSeal(entry);
  const proposed = input.bookingRooms && input.bookingRooms.length > 0 ? input.bookingRooms : null;
  const bookingRooms = proposed ?? readBookingRooms(seal, { checkIn, checkOut }, (id) => world.roomTypeOf.get(id));
  const booking = bookingRooms.length > 0 ? checkBookingRooms(world, bookingRooms, stayNights, { proposed: !!proposed, readAsFixed: !proposed && !sealHasBookingRooms(seal) }) : null;

  return { entryId, checkInDate: ymdUtc(checkIn), checkOutDate: ymdUtc(checkOut), nights: stayNights, types, booking };
}

export function checkBookingRooms(
  world: World,
  rooms: BookingRoom[],
  stayNights: string[],
  opts: { proposed: boolean; readAsFixed: boolean },
): BookingRoomsAnswer {
  const refusals: string[] = [];
  const inStay = new Set(stayNights);
  const roomLabel = (key: string) => `room ${key.replace(/^R/, "")}`;
  const runs: Array<{ key: string; run: BookingRoomRun; itemId: string }> = [];
  for (const r of rooms) {
    for (const run of bookingRoomRuns(r)) {
      const outside = run.nights.filter((d) => !inStay.has(d));
      if (outside.length > 0) {
        refusals.push(`The nights of ${roomLabel(r.key)} fall outside the stay (${outside.map(dayLabel).join(", ")})`);
        continue;
      }
      if (!world.typeName.has(run.roomTypeId)) {
        refusals.push(`${roomLabel(r.key)} names a room type the house does not sell`);
        continue;
      }
      if (run.roomId && world.roomTypeOf.get(run.roomId) !== run.roomTypeId) {
        refusals.push(`Room ${world.roomNumberOf.get(run.roomId) ?? run.roomId} is not a ${world.typeName.get(run.roomTypeId)}`);
        continue;
      }
      runs.push({ key: r.key, run, itemId: `__mine|${r.key}|${run.nights[0]}` });
    }
  }

  const placedRoom = new Map<string, string>();
  const moves: BookingRoomsAnswer["moves"] = [];
  const typeIds = [...new Set(runs.map((x) => x.run.roomTypeId))];
  for (const typeId of typeIds) {
    const type = world.chart.roomTypes.find((t) => t.id === typeId)!;
    const name = world.typeName.get(typeId)!;
    const worldItems = world.items.filter((it) => it.roomTypeId === typeId);
    const mine = runs.filter((x) => x.run.roomTypeId === typeId);
    const mineItems: PlacementItem[] = mine.map((x) => ({
      id: x.itemId,
      nights: x.run.nights.map((d) => world.index.get(d)!),
      fixedRoomId: x.run.fixed ? x.run.roomId : null,
      currentRoomId: x.run.roomId,
    }));
    const res = placeStays({ roomIds: type.roomIds, unusable: world.unusable, items: [...worldItems, ...mineItems] });

    // A fixed room of this booking on a night someone else holds, or out of order.
    for (const c of res.fixedClashes) {
      const ours = c.itemIds.filter((id) => id.startsWith("__mine|"));
      if (ours.length === 0) continue;
      const night = world.chart.nights[c.night];
      const roomNo = world.roomNumberOf.get(c.roomId) ?? c.roomId;
      const others = c.itemIds.filter((id) => !id.startsWith("__mine|")).map((id) => world.items.find((w) => w.id === id)!.entryId);
      if (others.length > 0) refusals.push(`Room ${roomNo} is held for ${world.bookingName.get(others[0]) ?? others[0]} on ${dayLabel(night)}`);
      else if (ours.length > 1) refusals.push(`Room ${roomNo} is named for two of this booking's rooms on ${dayLabel(night)}`);
      if (c.outOfOrder) refusals.push(`Room ${roomNo} is out of order on ${dayLabel(night)}`);
    }

    if (!res.ok) {
      if (res.reason === "COUNT") {
        for (const n of res.shortNights) {
          const date = world.chart.nights[n];
          const asked = mineItems.filter((it) => !it.fixedRoomId && it.nights.includes(n)).length;
          const fixedHere = new Set(worldItems.concat(mineItems as WorldItem[]).filter((it) => it.fixedRoomId && it.nights.includes(n)).map((it) => it.fixedRoomId));
          const quietHere = worldItems.filter((it) => !it.fixedRoomId && it.nights.includes(n)).length;
          const free = type.roomIds.filter((r) => !world.unusable.get(r)?.has(n) && !fixedHere.has(r)).length - quietHere;
          refusals.push(`Only ${Math.max(0, free)} ${name} free on ${dayLabel(date)} — ${asked} asked`);
        }
      } else if (res.reason === "TOO_HARD") {
        refusals.push(`The ${name} rooms could not be weighed up in time — too many bookings over these nights. Choose particular rooms instead.`);
      } else {
        // Which of this booking's rooms is the one that cannot be given a single room?
        let culprit: (typeof mine)[number] | null = null;
        for (let k = 1; k <= mine.length && !culprit; k++) {
          const partial = placeStays({ roomIds: type.roomIds, unusable: world.unusable, items: [...worldItems, ...mineItems.slice(0, k)] });
          if (!partial.ok) culprit = mine[k - 1];
        }
        const who = culprit ? `${roomLabel(culprit.key)}'s stay (${spanWords(culprit.run.nights)})` : "the stay";
        refusals.push(
          `There is a ${name} free every night, but no one ${name} is free for all of ${who} — rooms held for other guests are in the way. Choose particular rooms night by night, or another type.`,
        );
      }
      continue;
    }
    for (const x of mine) {
      const r = res.roomOf.get(x.itemId);
      if (r) placedRoom.set(x.itemId, r);
    }
    for (const id of res.moved) {
      const w = worldItems.find((it) => it.id === id);
      if (!w || !w.currentRoomId) continue;
      moves.push({
        entryId: w.entryId,
        booking: world.bookingName.get(w.entryId) ?? w.entryId,
        fromRoomId: w.currentRoomId,
        toRoomId: res.roomOf.get(id)!,
        fromRoomNumber: world.roomNumberOf.get(w.currentRoomId) ?? w.currentRoomId,
        toRoomNumber: world.roomNumberOf.get(res.roomOf.get(id)!) ?? "",
        span: spanWords(w.nights.map((n) => world.chart.nights[n])),
      });
    }
  }

  const dedup = [...new Set(refusals)];
  return {
    source: opts.proposed ? "PROPOSED" : "SEAL",
    readAsFixed: opts.readAsFixed,
    fits: dedup.length === 0,
    refusals: dedup,
    rooms: rooms.map((r) => ({
      key: r.key,
      runs: runs
        .filter((x) => x.key === r.key)
        .map((x) => {
          const placed = placedRoom.get(x.itemId) ?? null;
          return {
            roomTypeId: x.run.roomTypeId,
            typeName: world.typeName.get(x.run.roomTypeId) ?? x.run.roomTypeId,
            nights: x.run.nights,
            span: spanWords(x.run.nights),
            fixed: x.run.fixed,
            roomId: x.run.roomId,
            roomNumber: x.run.roomId ? (world.roomNumberOf.get(x.run.roomId) ?? null) : null,
            placedRoomId: placed,
            placedRoomNumber: placed ? (world.roomNumberOf.get(placed) ?? null) : null,
          };
        }),
    })),
    moves,
  };
}
