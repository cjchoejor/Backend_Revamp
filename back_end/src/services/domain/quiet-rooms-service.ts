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
  const swap = <T>(v: T): T => relabelJson(v, map, meta.roomNumbers) as T;

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
  if (!seal) return none;
  const { checkIn, checkOut } = stayOf(e);
  const world = await buildWorld(prisma, { from: checkIn, to: checkOut, excludeEntryId: entryId });
  // A seal from before booking rooms reads as fixed rooms. It has nothing of its own to move, but
  // another booking's room the system chose may sit on one of them, and moves out of the way here
  // (2026-10-29): the warning box already says such a room is no clash, so the hold must agree.
  const rooms = readBookingRooms(seal, { checkIn, checkOut }, (id) => world.roomTypeOf.get(id));
  const units = roomUnitsOf(rooms);
  if (units.length === 0) return none;

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
        // Before it holds, a room the system chose moves off a room another booking picked, when one
        // nobody picked is free (2026-10-29).
        avoidPicked: u.quiet,
      }));
    const worldItems = world.items.filter((it) => it.roomTypeId === typeId);
    const res = placeStays({ roomIds: type.roomIds, unusable: world.unusable, items: [...worldItems, ...mine], soft: world.soft });
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
 * The desk chooses the booking's rooms itself, before the rooms are handed out — "give them 305
 * instead of 304" (same type). Several at once when the desk moves several rooms on the chart. Each
 * room given becomes fixed; a booking holding the chosen room quietly on those nights is moved out
 * of the way (into the room left, or wherever it fits). A room of another type is a room change, as
 * before. All the rooms are placed together, so moving a booking's rooms along by one row works.
 */
export async function chooseQuietRooms(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  picks: Array<{ fromRoomId: string; toRoomId: string }>,
): Promise<{ moved: boolean; othersMoved: number; given: Array<{ fromRoomId: string; toRoomId: string; toRoomNumber: string | null }> }> {
  if (picks.length === 0) throw new ValidationError("Name a room to give");
  const e = await loadEntry(prisma, entryId);
  if (!e) throw new NotFoundError("Entry");
  if (!QUIET_STAGES.includes(e.currentStage)) throw new ValidationError("Rooms are chosen this way only until they are handed out at Arrival");
  if (e.roomAssignments.length > 0) throw new ValidationError("The rooms are already handed out — change a room through the room change");
  const { checkIn, checkOut } = stayOf(e);
  const world = await buildWorld(prisma, { from: checkIn, to: checkOut, excludeEntryId: entryId });
  const plan = planChosenRooms(e, world, picks);
  const maps = new Map<string, Map<string, string>>();
  for (const [from, to] of plan.ownMap) addMove(maps, entryId, from, to);
  for (const m of plan.others) addMove(maps, m.entryId, m.fromRoomId, m.toRoomId);
  await applyQuietMoves(prisma, maps, { ...actor, reason: "The desk chose the room", forEntryId: entryId, roomNumbers: world.roomNumberOf });
  // The rooms the desk chose are fixed from now on.
  await markRoomsFixed(prisma, entryId, picks.map((p) => p.toRoomId));
  return {
    moved: true,
    othersMoved: new Set(plan.others.map((m) => m.entryId)).size,
    given: picks.map((p) => ({ ...p, toRoomNumber: world.roomNumberOf.get(p.toRoomId) ?? null })),
  };
}

/** One room given — the form the Rooms tab uses. */
export async function chooseQuietRoom(
  prisma: PrismaClient,
  entryId: string,
  actor: Actor,
  input: { fromRoomId: string; toRoomId: string },
): Promise<{ moved: boolean; othersMoved: number }> {
  const out = await chooseQuietRooms(prisma, entryId, actor, [input]);
  return { moved: out.moved, othersMoved: out.othersMoved };
}

type ChosenPlan = {
  /** This booking's rooms, old → new (the chosen ones and any quiet ones placed around them). */
  ownMap: Map<string, string>;
  /** Other bookings' quiet rooms moved out of the way. */
  others: Array<{ entryId: string; fromRoomId: string; toRoomId: string }>;
};

/** Place this booking's rooms with `picks` fixed — the one rule the act and the choices list share. Throws in words. */
function planChosenRooms(e: Loaded, world: World, picks: Array<{ fromRoomId: string; toRoomId: string }>): ChosenPlan {
  const seal = currentPassSeal(e);
  const { checkIn, checkOut } = stayOf(e);
  const rooms = sealHasBookingRooms(seal) ? readBookingRooms(seal, { checkIn, checkOut }, (id) => world.roomTypeOf.get(id)) : null;
  if (!rooms) throw new ValidationError("This booking's rooms were picked by number — change a room through the room change");
  const units = roomUnitsOf(rooms);
  const froms = new Set<string>();
  const tos = new Set<string>();
  const num = (id: string) => world.roomNumberOf.get(id) ?? "?";
  for (const p of picks) {
    const unit = units.find((u) => u.roomId === p.fromRoomId);
    if (!unit) throw new ValidationError("That room is not one of this booking's rooms");
    if (froms.has(p.fromRoomId)) throw new ValidationError(`Room ${num(p.fromRoomId)} is named twice`);
    if (tos.has(p.toRoomId)) throw new ValidationError(`Two rooms cannot both go to Room ${num(p.toRoomId)}`);
    froms.add(p.fromRoomId);
    tos.add(p.toRoomId);
    if (p.fromRoomId === p.toRoomId) throw new ValidationError(`Room ${num(p.toRoomId)} is already this room`);
    if (world.roomTypeOf.get(p.toRoomId) !== unit.roomTypeId) throw new ValidationError(`Room ${num(p.toRoomId)} is another room type — change it through the room change`);
  }
  // A room already the booking's may be chosen only when it moves on in the same act.
  for (const p of picks) {
    if (units.some((u) => u.roomId === p.toRoomId) && !froms.has(p.toRoomId)) throw new ValidationError(`Room ${num(p.toRoomId)} is already one of this booking's rooms`);
  }
  const target = new Map(picks.map((p) => [p.fromRoomId, p.toRoomId] as const));
  const ownMap = new Map<string, string>();
  const others: ChosenPlan["others"] = [];
  for (const typeId of new Set(picks.map((p) => world.roomTypeOf.get(p.toRoomId)!))) {
    const type = world.chart.roomTypes.find((t) => t.id === typeId)!;
    const mine: PlacementItem[] = units
      .filter((u) => u.roomTypeId === typeId)
      .map((u) => ({
        id: `__mine|${u.roomId}`,
        nights: u.nights.map((d) => world.index.get(d)!).filter((i) => i !== undefined),
        fixedRoomId: target.get(u.roomId) ?? (u.quiet ? null : u.roomId),
        currentRoomId: u.roomId,
      }));
    const worldItems = world.items.filter((it) => it.roomTypeId === typeId);
    const res = placeStays({ roomIds: type.roomIds, unusable: world.unusable, items: [...worldItems, ...mine] });
    for (const p of picks.filter((x) => world.roomTypeOf.get(x.toRoomId) === typeId)) {
      const clash = res.fixedClashes.find((c) => c.itemIds.includes(`__mine|${p.fromRoomId}`));
      if (clash) {
        const other = clash.itemIds.map((id) => world.items.find((w) => w.id === id)).find(Boolean);
        throw new ValidationError(
          clash.outOfOrder
            ? `Room ${num(p.toRoomId)} is out of order on one of these nights`
            : `Room ${num(p.toRoomId)} is held for ${other ? world.bookingName.get(other.entryId) : "another booking"} on these nights`,
        );
      }
    }
    if (!res.ok) throw new ValidationError(`${[...tos].map((t) => `Room ${num(t)}`).join(" and ")} cannot be given to this booking — the other ${type.name} rooms cannot make way`);
    for (const it of mine) if (it.currentRoomId) ownMap.set(it.currentRoomId, res.roomOf.get(it.id)!);
    for (const id of res.moved) {
      const w = worldItems.find((x) => x.id === id);
      if (w?.currentRoomId) others.push({ entryId: w.entryId, fromRoomId: w.currentRoomId, toRoomId: res.roomOf.get(id)! });
    }
  }
  for (const [k, v] of [...ownMap]) if (k === v) ownMap.delete(k);
  return { ownMap, others: others.filter((o) => o.fromRoomId !== o.toRoomId) };
}

/**
 * For the desk's "Give it this room": every other room of the same type over the room's nights, and
 * what giving it would do — free; held as the system's choice by another booking, which is moved to
 * another room of the type; held for a booking that cannot be moved; out of order. Nothing written.
 */
export async function listQuietRoomChoices(prisma: PrismaClient, entryId: string, fromRoomId: string) {
  const e = await loadEntry(prisma, entryId);
  if (!e) throw new NotFoundError("Entry");
  const { checkIn, checkOut } = stayOf(e);
  const world = await buildWorld(prisma, { from: checkIn, to: checkOut, excludeEntryId: entryId });
  const seal = currentPassSeal(e);
  const rooms = sealHasBookingRooms(seal) ? readBookingRooms(seal, { checkIn, checkOut }, (id) => world.roomTypeOf.get(id)) : [];
  const units = roomUnitsOf(rooms);
  const unit = units.find((u) => u.roomId === fromRoomId);
  if (!unit) throw new ValidationError("That room is not one of this booking's rooms");
  const type = world.chart.roomTypes.find((t) => t.id === unit.roomTypeId);
  if (!type) return { typeName: null, choices: [] };
  const own = new Set(units.map((u) => u.roomId));
  const faulty = new Set(world.chart.rooms.filter((r) => r.faultOpen).map((r) => r.id));
  const choices = type.roomIds
    .filter((id) => !own.has(id))
    .map((roomId) => {
      const roomNumber = world.roomNumberOf.get(roomId) ?? "?";
      try {
        const plan = planChosenRooms(e, world, [{ fromRoomId, toRoomId: roomId }]);
        const moves = plan.others.map((o) => ({
          booking: world.bookingName.get(o.entryId) ?? o.entryId,
          fromRoomNumber: world.roomNumberOf.get(o.fromRoomId) ?? "?",
          toRoomNumber: world.roomNumberOf.get(o.toRoomId) ?? "?",
        }));
        return {
          roomId,
          roomNumber,
          available: true,
          fault: faulty.has(roomId),
          moves,
          words: moves.length
            ? `held as the system's choice — ${moves.map((m) => `${m.booking.replace(/ \(ENT-[^)]+\)$/, "")} moves to ${m.toRoomNumber}`).join(", ")}`
            : "free",
        };
      } catch (err) {
        return { roomId, roomNumber, available: false, fault: faulty.has(roomId), moves: [], words: err instanceof Error ? err.message.replace(/^Room \S+ (is )?/, "") : "cannot be given" };
      }
    })
    .sort((a, b) => Number(b.available) - Number(a.available) || a.moves.length - b.moves.length || a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
  return { typeName: type.name, choices };
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
  // At Arrival the system's rooms are a PROPOSAL the desk confirms, so they are named by number
  // there; before it they are named by type (docs/room-types-until-arrival.md).
  const atArrival = e.currentStage === "S5";
  if (!e.checkInDate || !e.checkOutDate) return { byType, movable, atArrival, rooms: [] };
  const checkIn = utcDateOnly(e.checkInDate);
  const checkOut = utcDateOnly(e.checkOutDate);
  const roomRows = await prisma.room.findMany({ select: { id: true, roomNumber: true, roomTypeId: true, roomType: { select: { name: true } } } });
  const info = new Map(roomRows.map((r) => [r.id, r] as const));
  const rooms = readBookingRooms(seal, { checkIn, checkOut }, (id) => info.get(id)?.roomTypeId);
  // "Deluxe Double · room 2": every room of a type numbered in the order of its booking rooms, so a
  // label stays put when the system moves a room AND when the desk fixes another one — the meal
  // plan agreed for "room 2" must still read "room 2" after room 1 is given 206. A guest's own
  // (fixed) room is named by its number but keeps its place in the count; the desk's live labels
  // (`labelsForBookingRooms`) count the same way.
  const keyNo = (roomId: string) =>
    Math.min(...rooms.filter((r) => r.nights.some((n) => n.roomId === roomId)).map((r) => Number(r.key.slice(1)) || 999));
  const units = roomUnitsOf(rooms);
  const perType = new Map<string, number>();
  const out = units
    .sort((a, b) => keyNo(a.roomId) - keyNo(b.roomId) || a.nights[0].localeCompare(b.nights[0]))
    .map((u) => {
      const typeName = info.get(u.roomId)?.roomType?.name ?? "Room";
      const named = byType && u.quiet;
      const k = (perType.get(u.roomTypeId) ?? 0) + 1;
      perType.set(u.roomTypeId, k);
      const n = named ? k : null;
      return {
        roomId: u.roomId,
        roomNumber: info.get(u.roomId)?.roomNumber ?? null,
        roomTypeId: u.roomTypeId,
        typeName,
        nights: u.nights,
        quiet: named && movable,
        ordinal: n,
        label: n != null ? `${typeName} · room ${n}` : `Room ${info.get(u.roomId)?.roomNumber ?? "?"}`,
      };
    });
  return { byType, movable, atArrival, rooms: out, bookingRooms: rooms };
}

/**
 * The desk's name for each room the system chose and may still move — "Deluxe Double · room 1" —
 * keyed by the room behind it. Empty for a booking picked by number, and from Arrival on, where the
 * system's rooms are proposed by number for the desk to confirm. A room number is not a promise before then (docs/room-types-until-arrival.md).
 */
export async function quietRoomLabels(prisma: PrismaClient, entryId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const d = await describeBookingRooms(prisma, entryId);
    if (d.atArrival) return out; // the proposal is named by number
    for (const r of d.rooms) if (r.quiet) out.set(r.roomId, r.label);
  } catch {
    // An unknown booking names no rooms by type; the caller prints numbers as before.
  }
  return out;
}

function dayWords(ymd: string): string {
  return new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

// Re-exported so callers need only this module.
export type { World };
export { bookingRoomRuns };
