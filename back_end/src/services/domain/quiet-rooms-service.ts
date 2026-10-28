/**
 * Rooms the system chooses quietly (2026-10-28, docs/room-types-until-arrival.md, stages 2–5).
 *
 * A booking picked BY TYPE keeps "booking rooms" on its seal (`optionSelected.bookingRooms`): each
 * night a type, and the real room the system put it in. Until the rooms are handed out at Arrival,
 * the system may move such a room to another room of the same type when that lets a booking fit.
 *
 * A QUIET MOVE takes all of one booking's nights in one room to one other room of the same type,
 * and rewrites that booking's own records in one go — the pick in force, its provisional block,
 * its committed hold, its live quotations, its bed plan. Nothing else changes: the same type means
 * the same rate, so no figure moves, and no new pass, quotation or voucher is made. The quotation
 * and the proforma name rooms by type (2026-10-28), so no paper a guest holds names the old room.
 * The reservation's frozen copy is not rewritten (it is immutable); every reader takes the
 * quotation first, and the rooms are confirmed at Arrival from the pick.
 *
 * Which rooms are fixed: a room the desk or the guest chose, every room of a booking picked before
 * booking rooms existed, and every room once Arrival has assigned it.
 */
import { Prisma, type PrismaClient, type Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { listNightYmdsUtc, utcDateOnly } from "../../lib/stay-dates.js";
import {
  bookingRoomRuns,
  bookingRoomsFromCounts,
  fixAllBookingRooms,
  readBookingRooms,
  relabelJson,
  roomUnitsOf,
  sealFromBookingRooms,
  sealHasBookingRooms,
  type BookingRoom,
} from "../../lib/booking-rooms.js";
import { placeStays, type PlacementItem } from "../../lib/room-placement.js";
import { applyRoomFlagRepairs, planRoomFlagRepairs } from "../../lib/room-flag-repair.js";
import { buildWorld, checkBookingRooms, currentPassSeal, sealSelect, type BookingRoomsAnswer, type World } from "./room-placement-service.js";
import { selectOption } from "./s1-availability-service.js";

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };

const QUIET_STAGES: Stage[] = ["S1", "S2", "S3", "S4", "S5"];

const entrySelect = {
  id: true,
  inquiryId: true,
  currentStage: true,
  status: true,
  checkInDate: true,
  checkOutDate: true,
  numberOfRooms: true,
  ...sealSelect,
  roomAssignments: { select: { id: true }, take: 1 },
} as const;

/**
 * Rewrite one booking's records with `map` (old room id → new). Inside the caller's transaction.
 */
export async function relabelEntryRoomsTx(
  tx: Prisma.TransactionClient,
  entryId: string,
  map: Map<string, string>,
  meta: Actor & { reason: string; forEntryId?: string | null; roomNumbers: Map<string, string> },
): Promise<void> {
  if (map.size === 0) return;
  const entry = await tx.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      inquiryId: true,
      currentStage: true,
      bedPlan: true,
      carryOver: true,
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  const segId = entry.segments[0]?.id ?? null;
  const swap = <T>(v: T): T => relabelJson(v, map) as T;

  // The pick in force (the pass's newest sealed one).
  const seal = await tx.availabilityConfiguration.findFirst({
    where: { entryId, sealedAt: { not: null }, optionSelected: { not: Prisma.DbNull }, ...(segId ? { OR: [{ segmentId: segId }, { segmentId: null }] } : {}) },
    orderBy: { sealedAt: "desc" },
    select: { id: true, optionSelected: true },
  });
  if (seal?.optionSelected) {
    await tx.availabilityConfiguration.update({ where: { id: seal.id }, data: { optionSelected: swap(seal.optionSelected) as Prisma.InputJsonValue } });
  }
  // Its provisional block and its committed hold.
  for (const h of await tx.speculativeHold.findMany({ where: { entryId, state: "PLACED" }, select: { id: true, roomId: true, perNightBreakdown: true } })) {
    await tx.speculativeHold.update({
      where: { id: h.id },
      data: {
        roomId: h.roomId ? (map.get(h.roomId) ?? h.roomId) : h.roomId,
        ...(h.perNightBreakdown ? { perNightBreakdown: swap(h.perNightBreakdown) as Prisma.InputJsonValue } : {}),
      },
    });
  }
  const hold = await tx.committedHold.findUnique({ where: { entryId }, select: { id: true, state: true, roomId: true, perNightBreakdown: true } });
  if (hold && (hold.state === "PLACED" || hold.state === "CONFIRMED")) {
    await tx.committedHold.update({
      where: { id: hold.id },
      data: {
        roomId: hold.roomId ? (map.get(hold.roomId) ?? hold.roomId) : hold.roomId,
        ...(hold.perNightBreakdown ? { perNightBreakdown: swap(hold.perNightBreakdown) as Prisma.InputJsonValue } : {}),
      },
    });
  }
  // Its live quotations of this pass — the price rows keep their figures, only the room is relabelled.
  if (segId) {
    for (const q of await tx.quotation.findMany({ where: { entryId, segmentId: segId, state: { in: ["DRAFT", "SENT", "ACCEPTED"] } }, select: { id: true, commercialTerms: true } })) {
      await tx.quotation.update({ where: { id: q.id }, data: { commercialTerms: swap(q.commercialTerms) as Prisma.InputJsonValue } });
    }
  }
  await tx.entry.update({
    where: { id: entryId },
    data: {
      ...(entry.bedPlan ? { bedPlan: swap(entry.bedPlan) as Prisma.InputJsonValue } : {}),
      ...(entry.carryOver ? { carryOver: swap(entry.carryOver) as Prisma.InputJsonValue } : {}),
    },
  });
  const moves = [...map.entries()].map(([from, to]) => ({
    fromRoomId: from,
    toRoomId: to,
    fromRoomNumber: meta.roomNumbers.get(from) ?? from,
    toRoomNumber: meta.roomNumbers.get(to) ?? to,
  }));
  await tx.traceEvent.create({
    data: {
      eventType: "BOOKING_ROOMS.QUIET_MOVED",
      actorId: meta.actorId,
      actorLevel: meta.actorLevel,
      entityType: "Entry",
      entityId: entryId,
      operation: "UPDATE",
      timestamp: new Date(),
      stageContext: entry.currentStage,
      inquiryId: entry.inquiryId,
      entryId,
      payload: { moves, reason: meta.reason, forEntryId: meta.forEntryId ?? null } as Prisma.InputJsonValue,
    },
  });
}

/** Apply every booking's relabel in one transaction, then put the rooms' flags right. */
async function applyQuietMoves(
  prisma: PrismaClient,
  maps: Map<string, Map<string, string>>,
  meta: Actor & { reason: string; forEntryId: string | null; roomNumbers: Map<string, string> },
): Promise<void> {
  const touched = new Set<string>();
  for (const m of maps.values()) for (const [a, b] of m) touched.add(a).add(b);
  if (touched.size === 0) return;
  await prisma.$transaction(
    async (tx) => {
      for (const [entryId, map] of maps) {
        await relabelEntryRoomsTx(tx, entryId, map, { ...meta, forEntryId: entryId === meta.forEntryId ? null : meta.forEntryId });
      }
    },
    { timeout: 30_000 },
  );
  const plan = await planRoomFlagRepairs(prisma, { roomIds: [...touched] });
  if (plan.plan.length > 0) await applyRoomFlagRepairs(prisma, plan.plan, plan.today);
}

function addMove(maps: Map<string, Map<string, string>>, entryId: string, from: string, to: string) {
  if (from === to) return;
  const m = maps.get(entryId) ?? new Map<string, string>();
  m.set(from, to);
  maps.set(entryId, m);
}

type Loaded = NonNullable<Awaited<ReturnType<typeof loadEntry>>>;
async function loadEntry(prisma: PrismaClient, entryId: string) {
  return prisma.entry.findUnique({ where: { id: entryId }, select: entrySelect });
}

function stayOf(e: Loaded) {
  if (!e.checkInDate || !e.checkOutDate) throw new ValidationError("The booking has no stay dates yet");
  const checkIn = utcDateOnly(e.checkInDate);
  const checkOut = utcDateOnly(e.checkOutDate);
  return { checkIn, checkOut, nights: listNightYmdsUtc(checkIn, checkOut) };
}

/**
 * Place this booking's quiet rooms against the house as it stands, moving other bookings' quiet
 * rooms where that is what lets it fit. Called before a room is claimed (a provisional block, a
 * committed hold) and before the rooms are handed out at Arrival. A booking with no quiet rooms
 * is left as it is. Returns this booking's own relabel (so a caller holding an old room id can
 * follow it), or the refusals when even with moves it cannot fit.
 */
export async function ensureQuietPlacement(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  reason: string,
): Promise<{ changed: boolean; ownMap: Map<string, string>; refusals: string[] }> {
  const none = { changed: false, ownMap: new Map<string, string>(), refusals: [] as string[] };
  const e = await loadEntry(prisma, entryId);
  if (!e || !QUIET_STAGES.includes(e.currentStage) || e.roomAssignments.length > 0) return none;
  if (e.status !== "ACTIVE" && e.status !== "PARKED") return none;
  const seal = currentPassSeal(e);
  if (!sealHasBookingRooms(seal)) return none;
  const { checkIn, checkOut } = stayOf(e);
  const world = await buildWorld(prisma, { from: checkIn, to: checkOut, excludeEntryId: entryId });
  const rooms = readBookingRooms(seal, { checkIn, checkOut }, (id) => world.roomTypeOf.get(id));
  const units = roomUnitsOf(rooms);
  if (!units.some((u) => u.quiet)) return none;

  const maps = new Map<string, Map<string, string>>();
  const refusals: string[] = [];
  for (const typeId of new Set(units.map((u) => u.roomTypeId))) {
    const type = world.chart.roomTypes.find((t) => t.id === typeId);
    if (!type) continue;
    const mine: PlacementItem[] = units
      .filter((u) => u.roomTypeId === typeId)
      .map((u) => ({
        id: `__mine|${u.roomId}`,
        nights: u.nights.map((d) => world.index.get(d)!).filter((i) => i !== undefined),
        fixedRoomId: u.quiet ? null : u.roomId,
        currentRoomId: u.roomId,
      }));
    const worldItems = world.items.filter((it) => it.roomTypeId === typeId);
    const res = placeStays({ roomIds: type.roomIds, unusable: world.unusable, items: [...worldItems, ...mine] });
    if (!res.ok) {
      refusals.push(
        res.reason === "COUNT"
          ? `Not enough ${type.name} free over these nights for this booking`
          : `No ${type.name} is free for this booking's whole stay`,
      );
      continue;
    }
    for (const it of mine) if (it.currentRoomId && !it.fixedRoomId) addMove(maps, entryId, it.currentRoomId, res.roomOf.get(it.id)!);
    for (const id of res.moved) {
      const w = worldItems.find((x) => x.id === id);
      if (w?.currentRoomId) addMove(maps, w.entryId, w.currentRoomId, res.roomOf.get(id)!);
    }
  }
  if (refusals.length > 0) return { ...none, refusals };
  if (maps.size === 0) return none;
  await applyQuietMoves(prisma, maps, { ...actor, reason, forEntryId: entryId, roomNumbers: world.roomNumberOf });
  return { changed: true, ownMap: maps.get(entryId) ?? new Map(), refusals: [] };
}

export type SealByTypeInput = {
  configurationId: string;
  perNight: Array<{ date: string; types: Array<{ roomTypeId: string; count: number }> }>;
  fixedRoomIds?: string[];
};

export type SealByTypeAnswer = {
  fits: boolean;
  refusals: string[];
  bookingRooms: BookingRoom[];
  /** The rooms the system would put them in, night by night. */
  perNight: Array<{ date: string; roomIds: string[] }>;
  check: BookingRoomsAnswer | null;
  saved: boolean;
};

/**
 * The Inquiry step's pick BY TYPE — "2 Deluxe Double and 1 Standard Double, every night", with any
 * particular rooms the guest asked for. The system chooses the rooms (one room for each guest's
 * whole stay, moving other bookings' quiet rooms where it must) and saves the pick, the booking
 * rooms on it. `preview` answers the same question and writes nothing.
 */
export async function sealBookingRoomsByType(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  input: SealByTypeInput,
  opts: { preview?: boolean } = {},
): Promise<SealByTypeAnswer> {
  const e = await loadEntry(prisma, entryId);
  if (!e) throw new NotFoundError("Entry");
  if (e.status !== "ACTIVE" && e.status !== "PARKED") throw new ValidationError("This booking has ended — a sealed record is read-only");
  if (e.currentStage !== "S1") throw new ValidationError("Rooms are picked by type on the Inquiry step");
  const { checkIn, checkOut, nights } = stayOf(e);
  const cfg = await prisma.availabilityConfiguration.findUnique({ where: { id: input.configurationId }, select: { id: true, entryId: true, isStale: true, searchCriteria: true } });
  if (!cfg || cfg.entryId !== entryId) throw new NotFoundError("AvailabilityConfiguration");
  if (cfg.isStale && !opts.preview) throw new ValidationError("The house's answer is out of date — ask the house again");

  const world = await buildWorld(prisma, { from: checkIn, to: checkOut, excludeEntryId: entryId });
  const typeName = (id: string) => world.typeName.get(id) ?? "room";

  // ---- the counts, night by night ---------------------------------------------------------------
  const refusals: string[] = [];
  const counts = new Map<string, Map<string, number>>();
  const given = new Map(input.perNight.map((n) => [n.date.slice(0, 10), n.types] as const));
  const asked = e.numberOfRooms ?? 0;
  for (const date of nights) {
    const types = given.get(date);
    if (!types) {
      refusals.push(`No rooms are set for ${dayWords(date)}`);
      continue;
    }
    const m = new Map<string, number>();
    for (const t of types) {
      if (!world.typeName.has(t.roomTypeId)) {
        refusals.push("A room type the house does not sell was picked");
        continue;
      }
      const c = Math.max(0, Math.floor(Number(t.count) || 0));
      if (c > 0) m.set(t.roomTypeId, (m.get(t.roomTypeId) ?? 0) + c);
    }
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    if (asked > 0 && total !== asked) refusals.push(`${dayWords(date)} has ${total} room${total === 1 ? "" : "s"} — the booking asks for ${asked}`);
    counts.set(date, m);
  }
  for (const d of given.keys()) if (!nights.includes(d)) refusals.push(`${dayWords(d)} is not a night of the stay`);

  // ---- particular rooms the guest asked for ------------------------------------------------------
  const fixed: Array<{ roomId: string; roomTypeId: string }> = [];
  for (const roomId of [...new Set(input.fixedRoomIds ?? [])]) {
    const t = world.roomTypeOf.get(roomId);
    if (!t) {
      refusals.push("A room asked for is not one the house sells");
      continue;
    }
    fixed.push({ roomId, roomTypeId: t });
  }
  for (const date of nights) {
    const m = counts.get(date) ?? new Map<string, number>();
    const fixedOfType = new Map<string, number>();
    for (const f of fixed) fixedOfType.set(f.roomTypeId, (fixedOfType.get(f.roomTypeId) ?? 0) + 1);
    for (const [t, n] of fixedOfType) {
      if ((m.get(t) ?? 0) < n) {
        const rooms = fixed.filter((f) => f.roomTypeId === t).map((f) => world.roomNumberOf.get(f.roomId)).join(", ");
        refusals.push(`Room ${rooms} is a ${typeName(t)}, but only ${m.get(t) ?? 0} ${typeName(t)} ${(m.get(t) ?? 0) === 1 ? "is" : "are"} set on ${dayWords(date)}`);
      }
    }
  }

  const prevSeal = currentPassSeal(e);
  const previous = sealHasBookingRooms(prevSeal) ? readBookingRooms(prevSeal, { checkIn, checkOut }, (id) => world.roomTypeOf.get(id)) : null;
  const bookingRooms = refusals.length > 0 ? [] : bookingRoomsFromCounts({ nights, counts, fixed, previous });

  let check: BookingRoomsAnswer | null = null;
  let placedRooms: BookingRoom[] = bookingRooms;
  if (refusals.length === 0) {
    check = checkBookingRooms(world, bookingRooms, nights, { proposed: true, readAsFixed: false });
    refusals.push(...check.refusals);
    if (check.fits) {
      // Each run in the room the check put it in.
      const placedFor = new Map<string, string>(); // key|night -> room
      for (const r of check.rooms) for (const run of r.runs) for (const n of run.nights) if (run.placedRoomId) placedFor.set(`${r.key}|${n}`, run.placedRoomId);
      placedRooms = bookingRooms.map((r) => ({ key: r.key, nights: r.nights.map((n) => ({ ...n, roomId: placedFor.get(`${r.key}|${n.date}`) ?? n.roomId })) }));
      // The system never chooses a room with an open fault quietly.
      const faulty = new Set(world.chart.rooms.filter((r) => r.faultOpen).map((r) => r.id));
      for (const r of placedRooms) {
        for (const n of r.nights) {
          if (!n.fixed && n.roomId && faulty.has(n.roomId)) {
            refusals.push(`The only ${typeName(n.roomTypeId)} left on ${dayWords(n.date)} is Room ${world.roomNumberOf.get(n.roomId)}, which has an open fault — ask for it as a particular room to take it`);
            break;
          }
        }
      }
    }
  }
  const dedup = [...new Set(refusals)];
  const perNight = nights.map((date) => ({
    date,
    roomIds: placedRooms.flatMap((r) => r.nights.filter((n) => n.date === date && n.roomId).map((n) => n.roomId!)),
  }));
  const answer: SealByTypeAnswer = { fits: dedup.length === 0, refusals: dedup, bookingRooms: placedRooms, perNight, check, saved: false };
  if (opts.preview || dedup.length > 0) return answer;

  // ---- save: first the other bookings' quiet rooms the fit moves, then the pick ------------------
  const maps = new Map<string, Map<string, string>>();
  for (const m of check?.moves ?? []) addMove(maps, m.entryId, m.fromRoomId, m.toRoomId);
  await applyQuietMoves(prisma, maps, { ...actor, reason: "Made way for a booking picked by type", forEntryId: entryId, roomNumbers: world.roomNumberOf });
  const sealed = sealFromBookingRooms(placedRooms);
  await selectOption(prisma, input.configurationId, actor.actorId, { perNight }, { skipAvailability: true, bookingRooms: sealed.bookingRooms });
  await prisma.traceEvent.create({
    data: {
      eventType: "BOOKING_ROOMS.PICKED_BY_TYPE",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "Entry",
      entityId: entryId,
      operation: "UPDATE",
      timestamp: new Date(),
      stageContext: e.currentStage,
      inquiryId: e.inquiryId,
      entryId,
      payload: {
        perNight: input.perNight.map((n) => ({ date: n.date, types: n.types.filter((t) => t.count > 0).map((t) => ({ type: typeName(t.roomTypeId), count: t.count })) })),
        fixedRooms: fixed.map((f) => world.roomNumberOf.get(f.roomId)),
        othersMoved: [...maps.keys()],
      } as Prisma.InputJsonValue,
    },
  });
  return { ...answer, saved: true };
}

/**
 * The desk chooses one of the booking's rooms itself, before the rooms are handed out — "give
 * them 305 instead of 304" (same type). The room becomes fixed; a booking holding 305 quietly on
 * those nights is moved out of the way (into 304, or wherever it fits). A room of another type is
 * a room change, as before.
 */
export async function chooseQuietRoom(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  input: { fromRoomId: string; toRoomId: string },
): Promise<{ moved: boolean; othersMoved: number }> {
  const e = await loadEntry(prisma, entryId);
  if (!e) throw new NotFoundError("Entry");
  if (!QUIET_STAGES.includes(e.currentStage)) throw new ValidationError("Rooms are chosen this way only until they are handed out at Arrival");
  if (e.roomAssignments.length > 0) throw new ValidationError("The rooms are already handed out — change a room through the room change");
  const seal = currentPassSeal(e);
  const { checkIn, checkOut } = stayOf(e);
  const world = await buildWorld(prisma, { from: checkIn, to: checkOut, excludeEntryId: entryId });
  const rooms = sealHasBookingRooms(seal) ? readBookingRooms(seal, { checkIn, checkOut }, (id) => world.roomTypeOf.get(id)) : null;
  if (!rooms) throw new ValidationError("This booking's rooms were picked by number — change a room through the room change");
  const units = roomUnitsOf(rooms);
  const unit = units.find((u) => u.roomId === input.fromRoomId);
  if (!unit) throw new ValidationError("That room is not one of this booking's rooms");
  const toType = world.roomTypeOf.get(input.toRoomId);
  if (toType !== unit.roomTypeId) throw new ValidationError(`Room ${world.roomNumberOf.get(input.toRoomId) ?? "?"} is another room type — change it through the room change`);
  if (units.some((u) => u.roomId === input.toRoomId)) throw new ValidationError(`Room ${world.roomNumberOf.get(input.toRoomId)} is already one of this booking's rooms`);

  const type = world.chart.roomTypes.find((t) => t.id === unit.roomTypeId)!;
  const mine: PlacementItem[] = units
    .filter((u) => u.roomTypeId === unit.roomTypeId)
    .map((u) => ({
      id: `__mine|${u.roomId}`,
      nights: u.nights.map((d) => world.index.get(d)!).filter((i) => i !== undefined),
      fixedRoomId: u.roomId === input.fromRoomId ? input.toRoomId : u.quiet ? null : u.roomId,
      currentRoomId: u.roomId,
    }));
  const worldItems = world.items.filter((it) => it.roomTypeId === unit.roomTypeId);
  const res = placeStays({ roomIds: type.roomIds, unusable: world.unusable, items: [...worldItems, ...mine] });
  const clash = res.fixedClashes.find((c) => c.itemIds.includes(`__mine|${input.fromRoomId}`));
  if (clash) {
    const other = clash.itemIds.map((id) => world.items.find((w) => w.id === id)).find(Boolean);
    throw new ValidationError(
      clash.outOfOrder
        ? `Room ${world.roomNumberOf.get(input.toRoomId)} is out of order on one of these nights`
        : `Room ${world.roomNumberOf.get(input.toRoomId)} is held for ${other ? world.bookingName.get(other.entryId) : "another booking"} on these nights`,
    );
  }
  if (!res.ok) throw new ValidationError(`Room ${world.roomNumberOf.get(input.toRoomId)} cannot be given to this booking — the other ${type.name} rooms cannot make way`);

  const maps = new Map<string, Map<string, string>>();
  for (const it of mine) if (it.currentRoomId) addMove(maps, entryId, it.currentRoomId, res.roomOf.get(it.id)!);
  for (const id of res.moved) {
    const w = worldItems.find((x) => x.id === id);
    if (w?.currentRoomId) addMove(maps, w.entryId, w.currentRoomId, res.roomOf.get(id)!);
  }
  await applyQuietMoves(prisma, maps, { ...actor, reason: "The desk chose the room", forEntryId: entryId, roomNumbers: world.roomNumberOf });
  // The room the desk chose is fixed from now on.
  await markRoomsFixed(prisma, entryId, [input.toRoomId]);
  return { moved: true, othersMoved: [...maps.keys()].filter((k) => k !== entryId).length };
}

/** The named rooms (or every room) of the booking's booking rooms made fixed — the desk chose them. */
export async function markRoomsFixed(prisma: PrismaClient, entryId: string, roomIds?: string[]): Promise<void> {
  const e = await loadEntry(prisma, entryId);
  if (!e) return;
  const segId = e.segments[0]?.id ?? null;
  const seal = await prisma.availabilityConfiguration.findFirst({
    where: { entryId, sealedAt: { not: null }, ...(segId ? { OR: [{ segmentId: segId }, { segmentId: null }] } : {}) },
    orderBy: { sealedAt: "desc" },
    select: { id: true, optionSelected: true },
  });
  if (!seal?.optionSelected || !sealHasBookingRooms(seal.optionSelected)) return;
  const { checkIn, checkOut } = stayOf(e);
  const rooms = readBookingRooms(seal.optionSelected, { checkIn, checkOut }, () => "x");
  const only = roomIds ? new Set(roomIds) : null;
  const next = only
    ? rooms.map((r) => ({ key: r.key, nights: r.nights.map((n) => (n.roomId && only.has(n.roomId) ? { ...n, fixed: true } : n)) }))
    : fixAllBookingRooms(rooms);
  await prisma.availabilityConfiguration.update({
    where: { id: seal.id },
    data: { optionSelected: { ...(seal.optionSelected as Record<string, unknown>), bookingRooms: next } as Prisma.InputJsonValue },
  });
}

/**
 * For the desk: each of this booking's rooms, whether the system chose it (and may still move it)
 * or it is fixed, and its place in the booking ("Deluxe Double · room 2").
 */
export async function describeBookingRooms(prisma: PrismaClient, entryId: string) {
  const e = await loadEntry(prisma, entryId);
  if (!e) throw new NotFoundError("Entry");
  const seal = currentPassSeal(e);
  const byType = sealHasBookingRooms(seal);
  const movable = byType && QUIET_STAGES.includes(e.currentStage) && e.roomAssignments.length === 0 && (e.status === "ACTIVE" || e.status === "PARKED");
  if (!e.checkInDate || !e.checkOutDate) return { byType, movable, rooms: [] };
  const checkIn = utcDateOnly(e.checkInDate);
  const checkOut = utcDateOnly(e.checkOutDate);
  const roomRows = await prisma.room.findMany({ select: { id: true, roomNumber: true, roomTypeId: true, roomType: { select: { name: true } } } });
  const info = new Map(roomRows.map((r) => [r.id, r] as const));
  const rooms = readBookingRooms(seal, { checkIn, checkOut }, (id) => info.get(id)?.roomTypeId);
  // "Deluxe Double · room 2": a type's rooms numbered in the order of their booking rooms, so the
  // label stays put when the system moves a room.
  const keyNo = (roomId: string) =>
    Math.min(...rooms.filter((r) => r.nights.some((n) => n.roomId === roomId)).map((r) => Number(r.key.slice(1)) || 999));
  const units = roomUnitsOf(rooms);
  const perType = new Map<string, number>();
  const out = units
    .sort((a, b) => keyNo(a.roomId) - keyNo(b.roomId) || a.nights[0].localeCompare(b.nights[0]))
    .map((u) => {
      const n = (perType.get(u.roomTypeId) ?? 0) + 1;
      perType.set(u.roomTypeId, n);
      const typeName = info.get(u.roomId)?.roomType?.name ?? "Room";
      return {
        roomId: u.roomId,
        roomNumber: info.get(u.roomId)?.roomNumber ?? null,
        roomTypeId: u.roomTypeId,
        typeName,
        nights: u.nights,
        quiet: byType && u.quiet && movable,
        label: byType && u.quiet ? `${typeName} · room ${n}` : `Room ${info.get(u.roomId)?.roomNumber ?? "?"}`,
      };
    });
  return { byType, movable, rooms: out, bookingRooms: rooms };
}

function dayWords(ymd: string): string {
  return new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

// Re-exported so callers need only this module.
export type { World };
export { bookingRoomRuns };
