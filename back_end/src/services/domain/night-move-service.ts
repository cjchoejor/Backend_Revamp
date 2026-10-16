import type { PrismaClient } from "@prisma/client";
import { Prisma, Stage } from "@prisma/client";
import { ValidationError } from "../../lib/errors.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { foldIsoNightsToRanges } from "../../lib/entry-inventory-claim.js";
import { findRoomBookingConflicts } from "../../lib/room-booking-conflicts.js";
import { hotelTodayUtc } from "../../lib/stay-dates.js";
import { resolveOperativeQuotation } from "../../lib/operative-quotation.js";
import {
  derivePartySlots,
  nightsByRoomFromPicture,
  planRoomOrder,
  resolveCompositionBasis,
  seatPartyRooms,
  type NightPicture,
} from "../../lib/party-seating.js";
import {
  enforceCommittedHoldRoomPhysicallyUsable,
  enforceNoOverlappingBookingForCommittedHold,
} from "../../policies/11-committed-hold/p26-committed-hold-inventory-availability.js";
import { changeRoomToNewSegment, shiftIsoDate, type RoomChangeOutcome, type RoomMoveWalkContext } from "./room-change-service.js";
import { buildQuotationPreview } from "./quotation-preview-service.js";
import { queryAvailability } from "./s1-availability-service.js";
import { amendNegotiationConfiguration, type NegotiationAmendmentOutcome } from "./negotiation-amendment-service.js";
import { loadChildPolicyBundle } from "./child-policy-service.js";
import { validateCapacity } from "./capacity-validation-service.js";
import type { RoomCompositionServiceInput } from "./s2-quotation-service.js";
import {
  DAY,
  RANK,
  STAGE_WORD,
  abandonPieces,
  createPieceEntry,
  createSplitInquiry,
  errorMessage,
  fmtDay,
  iso,
  loadSource,
  nightsBetween,
  nightsLabel,
  partyWords,
  stampPiece,
  walkPiece,
  type Actor,
  type Party,
  type Piece,
  type PieceOutcome,
  type PriceMode,
  type SplitTarget,
} from "./room-split-service.js";

/**
 * MOVING A NIGHT (2026-10-14, operator: "I can't select each night's room separately ... say I want
 * to move room 206 for the 22nd to another date ... there is a gap between the room staying on the
 * 21st and the same room staying on the 23rd; if it moved to a different room on the 22nd that would
 * be no problem, but if it is a different date, the system should make all of it a different entry
 * under the same enquiry, or like before, a new enquiry").
 *
 * Rulings the same day (asked): a one-room booking keeps the EARLIEST stay left at its own dates and
 * every other stay becomes a booking of its own; on a booking with other rooms the room leaves it,
 * and each of its stays becomes a booking of its own (a booking cannot carry fewer guests on some
 * nights); the same-or-new-enquiry choice is asked once and applies to every new booking (a new
 * enquiry holds them all); the desk picks a night with Alt on the house chart.
 *
 * SEVERAL ROOMS AT ONCE (2026-10-15, operator: "hold Alt and Ctrl and select multiple individual
 * rooms and move it"). Rulings (asked): the rooms are ONE booking's; each room carries its own run of
 * nights, and the drag shifts every pick by the same days and rows; stays that leave the booking on
 * the same dates are ONE booking holding all their rooms. When every room of the booking is picked
 * their nights must be the same — the booking then keeps its earliest stay with all its rooms, as a
 * one-room booking does; otherwise the picked rooms leave the booking with their guests.
 *
 * ONE ROOM A NIGHT (2026-10-15, operator: "305 on the 23rd was in 206 on the 23rd, but I can't move it
 * back to 206 in any dates"): a booking whose rooms change between nights but holds one room each
 * night is one party moving rooms — it is cut as a one-room booking is: it keeps its earliest stay,
 * every other stay is a booking of its own with its rooms night by night, and each room may carry its
 * own nights. Moved nights that follow one another are one stay.
 *
 * Two shapes, each the governed act its step already has:
 *
 *   - **Same dates, another room** — a room change for those nights: at Negotiation the change of
 *     configuration, from Set up on the room-change walk in its per-night form, one walk per room.
 *   - **Other dates** — the stays are cut apart. The original: at Negotiation the change of
 *     configuration (its dates, or its party and rooms); from Set up to Arrival the walk shortening
 *     the stay (every room picked) or splitting the rooms off (some). Each new stay: a booking made
 *     under the enquiry chosen, walked to the original's step or started at Inquiry, as a split does.
 *
 * The preview writes nothing; every refusal is said in words before anything runs.
 */

type NightPriceMode = "KEEP" | "NEW_DATES" | "NEW_TYPE";
export type NightMoveMode = "ROOM_CHANGE" | "SPLIT";

/** One room's nights in a move — the room, the run of its nights that moves, where they land. */
export type NightMovePick = { fromRoomId: string; nights: string[]; toRoomId?: string | null };

/** At most this many rooms' nights move in one go. */
const MAX_PICKS = 8;

export type NightMoveRequest = {
  entryId: string;
  /** The room whose nights were dragged (one room — `picks` names several). */
  fromRoomId?: string;
  /** The nights that move, as they are now ("YYYY-MM-DD") — one run of the room's nights. */
  nights?: string[];
  /** Where they land; the same room when only the dates change. */
  toRoomId?: string | null;
  /** Several rooms' nights moved together (2026-10-15) — the first is the one dragged. */
  picks?: NightMovePick[];
  /** The dragged room's first moved night's new date — the same as its first night when only rooms change. */
  newFirstNight: string;
  /** KEEP, or a re-price: at the new dates (other dates) or at the new room type (same dates). */
  priceMode?: NightPriceMode;
  guestAgreedNote?: string | null;
  target?: SplitTarget;
  reason?: string | null;
};

export type NightMovePreview = {
  ok: boolean;
  mode: NightMoveMode;
  entryId: string;
  bookingLabel: string;
  guestName: string | null;
  inquiryId: string;
  stage: string;
  stageWord: string;
  /** The room dragged — the first of `moves`. */
  from: { roomId: string; roomNumber: string; nightsLabel: string; nights: number };
  to: { roomId: string; roomNumber: string; nightsLabel: string; checkInDate: string; checkOutDate: string; nights: number; sameType: boolean };
  /** Every room's nights that move, the dragged room first. */
  moves: Array<{
    fromRoomId: string;
    fromRoomNumber: string;
    fromLabel: string;
    toRoomId: string;
    toRoomNumber: string;
    toLabel: string;
    nights: number;
    sameType: boolean;
  }>;
  shiftDays: number;
  /** What the booking keeps, and its price before and after. */
  original: { words: string; guests: string; priceBefore: number | null; priceAfter: number | null; note: string | null };
  /** Every new booking the move makes (other dates only), in date order. */
  pieces: Array<{
    kind: "MOVED" | "LEFT";
    /** "205" · "205 + 305" */
    roomNumber: string;
    roomNumbers: string[];
    checkInDate: string;
    checkOutDate: string;
    nights: number;
    nightsLabel: string;
    guests: string;
    total: number | null;
  }>;
  price: {
    currency: string | null;
    /** The one price choice the move asks: the moved nights at the new dates, or another room type. */
    choice: { kind: "DATES" | "TYPE"; keep: number | null; other: number | null } | null;
  };
  authority: { needed: "L1" | "L2"; actorLevel: string; ok: boolean; why: string };
  /** Other dates only. */
  targets: Record<SplitTarget, { path: string[]; papers: string[]; refusals: string[] }> | null;
  /** Same dates only: what the room change does, step by step. */
  path: string[];
  notes: string[];
  refusals: string[];
};

export type NightMoveResult = {
  mode: NightMoveMode;
  target: SplitTarget | null;
  source: { entryId: string; route: "NEGOTIATION" | "WALK"; walk: RoomChangeOutcome | null; amendment: NegotiationAmendmentOutcome | null };
  /** Same dates, several rooms: one walk per room, in order — a refused one stops the rest. */
  walks: Array<{ fromRoomNumber: string; toRoomNumber: string; nightsLabel: string; walk: RoomChangeOutcome | null; error: string | null }>;
  created: Array<PieceOutcome & { kind: "MOVED" | "LEFT"; roomNumber: string }>;
  newInquiryId: string | null;
  /** Something the desk still has to do — a mixed booking's second step refused after the first ran. */
  followUp?: string | null;
};

const runsOf = (nights: string[]): string[][] =>
  foldIsoNightsToRanges([...new Set(nights)].sort()).map((r) => nightsBetween(r.startDate, r.endDate));
const spanOf = (nights: string[]) => ({ checkIn: nights[0], checkOut: shiftIsoDate(nights[nights.length - 1], 1) });

async function planNightMove(prisma: PrismaClient, actor: Actor, input: NightMoveRequest) {
  const entry = await loadSource(prisma, input.entryId);
  const refusals: string[] = [];
  const notes: string[] = [];
  const stage = entry.currentStage;
  const isFom = (RANK[actor.actorLevel] ?? 0) >= 2;
  const guest =
    [entry.guestProfile?.firstName, entry.guestProfile?.lastName].filter(Boolean).join(" ").trim() ||
    [entry.inquiry?.callerFirstName, entry.inquiry?.callerLastName].filter(Boolean).join(" ").trim() ||
    null;

  const reservationOfPass = entry.reservation && entry.reservation.segmentId === entry.segments[0]?.id ? entry.reservation : null;
  const priorIn = reservationOfPass?.frozenCheckInDate ?? entry.checkInDate;
  const priorOut = reservationOfPass?.frozenCheckOutDate ?? entry.checkOutDate;
  if (!priorIn || !priorOut) throw new ValidationError("This booking has no stay dates");

  // The booking's rooms night by night, from its sealed pick.
  const sealed = entry.availabilityConfigs[0] ?? null;
  const sel = readOptionSelected(sealed?.optionSelected ?? null);
  const picture: NightPicture =
    sel.perNight && sel.perNight.length > 0
      ? sel.perNight.map((n) => ({ date: String(n.date).slice(0, 10), roomIds: [...n.roomIds] }))
      : nightsBetween(priorIn, priorOut).map((date) => ({ date, roomIds: [...sel.distinctRoomIds] }));
  const planRooms = Array.from(new Set(picture.flatMap((n) => n.roomIds)));
  if (!sealed || planRooms.length === 0) refusals.push("No rooms are picked for this booking yet");

  // The picks: one room, or several (the room dragged first).
  const asked: NightMovePick[] = input.picks?.length
    ? input.picks
    : [{ fromRoomId: input.fromRoomId ?? "", nights: input.nights ?? [], toRoomId: input.toRoomId ?? null }];
  if (asked.length > MAX_PICKS) throw new ValidationError(`Move at most ${MAX_PICKS} rooms' nights at a time`);
  const askedIds = asked.flatMap((a) => [String(a.fromRoomId ?? "").trim(), String(a.toRoomId ?? "").trim()]).filter(Boolean);
  const roomRows = await prisma.room.findMany({ where: { id: { in: Array.from(new Set([...planRooms, ...askedIds])) } }, include: { roomType: true } });
  const roomById = new Map(roomRows.map((r) => [r.id, r]));
  const no = (id: string) => roomById.get(id)?.roomNumber ?? "?";
  const multi = asked.length > 1;

  type PickPlan = {
    R: string;
    to: string;
    moved: string[];
    movedNew: string[];
    rNights: string[];
    fromRoom: (typeof roomRows)[number];
    toRoom: (typeof roomRows)[number];
    sameType: boolean;
  };
  const picks: PickPlan[] = [];
  for (const a of asked) {
    const R = String(a.fromRoomId ?? "").trim();
    if (!R || !planRooms.includes(R)) throw new ValidationError("That room is not part of this booking's room plan");
    if (picks.some((p) => p.R === R)) throw new ValidationError(`Room ${no(R)} is picked twice — pick each room once`);
    const to = String(a.toRoomId ?? "").trim() || R;
    if (!roomById.has(to)) throw new ValidationError("The room to move into is not in the house");
    const rNights = picture.filter((n) => n.roomIds.includes(R)).map((n) => n.date);
    const moved = Array.from(new Set((a.nights ?? []).map((d) => String(d).slice(0, 10)))).sort();
    if (moved.length === 0) throw new ValidationError("Name the nights that move");
    for (const d of moved) {
      if (!rNights.includes(d)) throw new ValidationError(`Room ${no(R)} does not hold ${fmtDay(d)} on this booking`);
    }
    if (runsOf(moved).length !== 1) {
      refusals.push(
        multi
          ? `Room ${no(R)}'s nights that move must follow one another — move them one run at a time`
          : "The nights that move must follow one another — move them one run at a time",
      );
    }
    const fromRoom = roomById.get(R)!;
    const toRoom = roomById.get(to)!;
    picks.push({ R, to, moved, movedNew: [], rNights, fromRoom, toRoom, sameType: toRoom.roomTypeId === fromRoom.roomTypeId });
  }

  const g = picks[0];
  const newFirst = String(input.newFirstNight ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newFirst)) throw new ValidationError("newFirstNight must be a date (YYYY-MM-DD)");
  const shiftDays = Math.round((Date.parse(`${newFirst}T00:00:00.000Z`) - Date.parse(`${g.moved[0]}T00:00:00.000Z`)) / DAY);
  const mode: NightMoveMode = shiftDays === 0 ? "ROOM_CHANGE" : "SPLIT";
  for (const p of picks) p.movedNew = p.moved.map((d) => shiftIsoDate(d, shiftDays));
  const sameTypeAll = picks.every((p) => p.sameType);
  if (mode === "ROOM_CHANGE") {
    const idle = picks.filter((p) => p.to === p.R);
    if (idle.length === picks.length) refusals.push("Nothing moves — drop the night on another room or on other dates");
    else for (const p of idle) refusals.push(`Room ${no(p.R)} would stay where it is — every picked room moves by the same rows`);
  }

  // The step the booking is at.
  if (entry.status === "PARKED") refusals.push("This booking is parked — resume it first");
  else if (entry.status !== "ACTIVE") refusals.push("This booking has ended — its rooms are a record now");
  else if (stage === Stage.S1) refusals.push("At Inquiry the rooms are picked on the booking's Inquiry step — change them there");
  else if (stage === Stage.S8 || stage === Stage.S9) refusals.push("The guest has left or is leaving — a stay that has happened does not move");
  else if (mode === "SPLIT" && (stage === Stage.S6 || stage === Stage.S7)) {
    refusals.push("The guest is checking in or in house — a night leaves the stay through Leaving early, not by moving it to other dates");
  }
  const todayIso = iso(hotelTodayUtc());
  if (picks.some((p) => p.movedNew[0] < todayIso)) refusals.push("The night would land before today at the hotel");
  if (stage === Stage.S7 && picks.some((p) => p.moved[0] < todayIso)) refusals.push("A night already slept does not move");

  const operative = resolveOperativeQuotation(entry.quotations, entry.segments[0]?.id ?? null);
  const currency = ((operative?.commercialTerms as Record<string, unknown> | null)?.currency as string | undefined) ?? null;
  const priceBefore = operative?.totalAmount != null ? Number(operative.totalAmount) : null;

  return {
    entry, stage, isFom, guest, refusals, notes, priorIn, priorOut, picture, planRooms, roomById, no, picks, multi, sameTypeAll,
    shiftDays, mode, todayIso, currency, priceBefore,
    // The room dragged — what the one-room shape reads.
    R: g.R, toRoomId: g.to, rNights: g.rNights, moved: g.moved, movedNew: g.movedNew, fromRoom: g.fromRoom, toRoom: g.toRoom, sameType: g.sameType,
  };
}
type Base = Awaited<ReturnType<typeof planNightMove>>;
type PickPlan = Base["picks"][number];

/** The room-change walk's per-night form for one room's nights that move — and the rest of its nights kept. */
function roomChangeForm(b: Base, p: PickPlan): { perNight?: Array<{ date: string; roomId: string }>; toRoomId?: string } {
  const nights = b.stage === Stage.S7 ? p.rNights.filter((d) => d >= b.todayIso) : p.rNights;
  if (nights.every((d) => p.moved.includes(d))) return { toRoomId: p.to };
  return { perNight: nights.map((date) => ({ date, roomId: p.moved.includes(date) ? p.to : p.R })) };
}

function moveContextOf(mode: "KEEP" | "NEW_TYPE", note: string | null): RoomMoveWalkContext {
  return { moveId: null, legId: null, partnerEntryId: null, partnerLabel: null, tolerate: [], priceMode: mode, guestAgreedNote: note };
}

type DryPlan = NonNullable<RoomChangeOutcome["plan"]>;

/** A plan's figure, priced the way the silent quote will. */
async function pricePlan(prisma: PrismaClient, entryId: string, p: DryPlan | null): Promise<number | null> {
  if (!p?.compositions) return null;
  const after = await buildQuotationPreview(
    prisma,
    entryId,
    {
      roomCompositions: p.compositions as never,
      discount: p.discount ? { percent: p.discount.discountPercent ?? null, amount: p.discount.discountAmount ?? null } : null,
    },
    { planRoomIds: p.planRoomIds, stayOverride: { checkIn: new Date(p.checkIn), checkOut: new Date(p.checkOut), perRoomNightCounts: new Map(Object.entries(p.perRoomNightCounts ?? {})) } },
  );
  return after.payable;
}

/**
 * Several rooms' room changes as ONE plan, for the figure the walks will end on: each dry run changed
 * its own room, so the rows of a picked room and its new room come from that room's run, every other
 * row from the first. One composition row per room is the walk's invariant, so the rows name the plan.
 */
function combinePlans(drys: RoomChangeOutcome[], picks: PickPlan[]): DryPlan | null {
  const plans = drys.map((d) => d.plan ?? null);
  if (plans.some((p) => !p?.compositions)) return null;
  const owner = new Map<string, number>();
  picks.forEach((p, i) => {
    if (i === 0) return;
    owner.set(p.R, i);
    owner.set(p.to, i);
  });
  type Row = { roomId: string };
  const rows: Row[] = [];
  const counts: Record<string, number> = {};
  plans.forEach((plan, i) => {
    for (const r of plan!.compositions as unknown as Row[]) {
      const o = owner.get(r.roomId) ?? 0;
      if (o !== i) continue;
      rows.push(r);
      const c = plan!.perRoomNightCounts?.[r.roomId];
      if (c != null) counts[r.roomId] = c;
    }
  });
  const first = plans[0]!;
  return { ...first, compositions: rows as never, planRoomIds: Array.from(new Set(rows.map((r) => r.roomId))), perRoomNightCounts: counts };
}

/** "Room 205" · "Rooms 205 + 305" */
const roomsWords = (ids: string[], no: (id: string) => string) =>
  ids.length === 1 ? `Room ${no(ids[0])}` : `Rooms ${ids.map(no).join(" + ")}`;

type Seg = { kind: "MOVED" | "LEFT"; src: string; roomId: string; nights: string[]; srcNights: string[]; shift: number };
type NightPiece = Piece & {
  kind: "MOVED" | "LEFT";
  /** A moved stay's rows priced both ways — the one price choice the move asks. */
  alt: { keep: RoomCompositionServiceInput[]; fresh: RoomCompositionServiceInput[] } | null;
};

/** Everything the split shape needs, validated once. */
async function planSplitNights(prisma: PrismaClient, actor: Actor, b: Base, input: NightMoveRequest) {
  const { entry, picture, planRooms, roomById, no, picks, shiftDays, refusals, notes, stage, isFom } = b;
  const allNights = picture.map((n) => n.date);
  const pickedSet = new Set(picks.map((p) => p.R));
  const allPicked = planRooms.every((id) => pickedSet.has(id));
  /** One room a night — one party moving between rooms: the booking is cut as a whole (2026-10-15). */
  const sequential = picture.length > 0 && picture.every((n) => n.roomIds.length === 1);
  const shape = (n: { roomIds: string[] }) => [...n.roomIds].sort().join("|");
  /**
   * Several rooms on some nights AND rooms that change between nights (2026-10-16, operator: "rule
   * one should happen"): the booking keeps its stay from the start up to the night that changes,
   * every other stay — nights in a row with the same guests — is a booking of its own with its rooms
   * night by night, and the moved nights are bookings of their own.
   */
  const mixed = !sequential && picture.some((n) => shape(n) !== shape(picture[0]));
  /** The booking as a whole keeps its earliest stay — every room picked (a one-room booking always is), or one room a night. */
  const single = !mixed && (allPicked || sequential);
  const movedAll = new Set(picks.flatMap((p) => p.moved));
  /** The booking's nights with the moved room-nights taken out. */
  const remaining = picture.map((n) => ({ date: n.date, roomIds: n.roomIds.filter((id) => !picks.some((p) => p.R === id && p.moved.includes(n.date))) }));
  if (mixed) {
    if (remaining.every((n) => n.roomIds.length === 0)) refusals.push("Every night of this booking would move — drag its bars without Alt to move the whole stay");
  } else if (single) {
    if (allNights.every((d) => movedAll.has(d))) {
      refusals.push(
        planRooms.length === 1
          ? `Every night of Room ${no(picks[0].R)} would move — drag it without Alt to move the whole room`
          : "Every night of this booking would move — drag its bars without Alt to move the whole stay",
      );
    }
  } else {
    for (const p of picks) {
      if (p.moved.length === p.rNights.length) refusals.push(`Every night of Room ${no(p.R)} would move — drag it without Alt to move the whole room`);
    }
  }
  if (allPicked && !sequential && !mixed && picks.length > 1 && picks.some((p) => p.moved.join("|") !== picks[0].moved.join("|"))) {
    refusals.push("Every room of this booking is picked — pick the same nights on each room, or leave one room out");
  }

  // Who sleeps in which room — the booking's own seating decides who goes with each stay.
  const basis = resolveCompositionBasis<RoomCompositionServiceInput>(entry);
  const rows = basis.compositions ?? [];
  const rowOf = (id: string) => rows.find((r) => r.roomId === id) ?? null;
  if (rows.length === 0) refusals.push("This booking has no record of who sleeps in which room — set the rooms' guests at Negotiation first");
  else for (const p of picks) if (!rowOf(p.R)) refusals.push(`Room ${no(p.R)} has no guests recorded on the booking — set them at Negotiation first`);
  const bundle = await loadChildPolicyBundle(prisma).catch(() => null);
  const slots = derivePartySlots(entry, { youngChildMaxAge: bundle?.ageBands.youngChildMaxAge ?? 5, childMaxAge: bundle?.ageBands.childMaxAge ?? 10 });
  const seating = seatPartyRooms({ slots, rows, order: planRoomOrder(picture), nightsByRoom: nightsByRoomFromPicture(picture) });
  const childAges = entry.childAges ?? [];
  const partyWhere = (keep: (rooms: string[], slotKey: string) => boolean): Party => {
    const p: Party = { adultCount: 0, childCount: 0, childAges: [], guestCount: 0 };
    for (const slot of slots) {
      if (!keep(seating.get(slot.key) ?? [], slot.key)) continue;
      const isChild = slot.key.startsWith("K");
      const age = isChild ? childAges[Number(slot.key.slice(1))] : null;
      if (isChild && typeof age === "number") p.childAges.push(age);
      else p.adultCount += 1;
    }
    p.childCount = p.childAges.length;
    p.guestCount = p.adultCount + p.childCount;
    return p;
  };
  const whole = partyWhere(() => true);
  /** The guests of these rooms. */
  const partyOf = (rooms: Set<string>) => partyWhere((seated) => seated.some((id) => rooms.has(id)));
  /** The guests who sleep in these rooms on this night. */
  const presentOn = (n: { roomIds: string[] }) => slots.filter((sl) => (seating.get(sl.key) ?? []).some((id) => n.roomIds.includes(id))).map((sl) => sl.key);
  /** A mixed booking's stays left at their own dates: nights in a row with the same guests. */
  const mixedStays: Array<{ picture: NightPicture; guests: Set<string> }> = [];
  if (mixed) {
    let prevIdx = -2;
    remaining.forEach((n, i) => {
      if (!n.roomIds.length) return;
      const key = presentOn(n).sort().join(",");
      const last = mixedStays[mixedStays.length - 1];
      if (last && prevIdx === i - 1 && [...last.guests].sort().join(",") === key) last.picture.push({ date: n.date, roomIds: [...n.roomIds] });
      else mixedStays.push({ picture: [{ date: n.date, roomIds: [...n.roomIds] }], guests: new Set(key ? key.split(",") : []) });
      prevIdx = i;
    });
  }
  const keptStay = mixed ? mixedStays[0] ?? null : null;
  const leaving = single ? whole : mixed ? partyWhere((_r, k) => !(keptStay?.guests.has(k) ?? false)) : partyOf(pickedSet);
  const stays = single ? whole : mixed ? partyWhere((_r, k) => keptStay?.guests.has(k) ?? false) : partyWhere((seated) => !seated.some((id) => pickedSet.has(id)));
  /** A mixed booking's rooms that leave the nights it keeps — a second step after the stay is shortened. */
  let keptRemoveRooms: string[] = [];
  if (keptStay) {
    const keptDates = keptStay.picture.map((n) => n.date);
    const before = picture.filter((n) => keptDates.includes(n.date));
    const keptIds = new Set(keptStay.picture.flatMap((n) => n.roomIds));
    keptRemoveRooms = Array.from(new Set(before.flatMap((n) => n.roomIds))).filter((id) => !keptIds.has(id));
    const patchy = [...keptIds].filter((id) => before.some((n) => n.roomIds.includes(id) && !keptStay.picture.find((k) => k.date === n.date)?.roomIds.includes(id)));
    if (patchy.length) {
      refusals.push(`${roomsWords(patchy, no)} would stay on some of the nights this booking keeps and not others — move ${patchy.length === 1 ? "its" : "their"} other nights too, or move the whole room`);
    }
  }

  // Each stay's row: the room's own, on its room and nights, priced as chosen.
  const priorTerms = (basis.terms ?? null) as Record<string, unknown> | null;
  const perRoom = ((priorTerms?.compositionTotals ?? null) as { perRoom?: Array<{ roomId?: string; roomRate?: unknown }> } | null)?.perRoom ?? [];
  const pricedAt = (id: string) => {
    const v = perRoom.find((r) => r.roomId === id)?.roomRate;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Number(v.toFixed(2)) : null;
  };
  const crossType = (src: string, roomId: string) => roomId !== src && roomById.get(roomId)?.roomTypeId !== roomById.get(src)?.roomTypeId;
  /** The rate a room keeps on another room: its negotiated rate on the same type, else the rate it was priced at. */
  const keepRateOf = (src: string, roomId: string) => (!crossType(src, roomId) ? rowOf(src)?.negotiatedRoomRate : null) ?? pricedAt(src);
  const movedMode: PriceMode = input.priceMode === "NEW_DATES" ? "NEW_DATES" : "KEEP";
  const rowFor = (src: string, nights: string[], shift: number, roomId: string, m: PriceMode): RoomCompositionServiceInput | null => {
    const row = rowOf(src);
    if (!row) return null;
    const ct = crossType(src, roomId);
    const base: RoomCompositionServiceInput = {
      ...row,
      roomId,
      startDate: undefined,
      endDate: undefined,
      nightMealOverrides: (row.nightMealOverrides ?? [])
        .filter((o) => nights.includes(String(o.date).slice(0, 10)))
        .map((o) => ({ ...o, date: shiftIsoDate(String(o.date).slice(0, 10), shift) })),
      ...(ct ? { negotiatedRoomRate: undefined } : {}),
    };
    if (m !== "KEEP") return { ...base, negotiatedRoomRate: ct ? undefined : base.negotiatedRoomRate };
    const rate = keepRateOf(src, roomId);
    return rate != null ? { ...base, negotiatedRoomRate: rate } : base;
  };
  for (const p of picks) {
    if (movedMode === "KEEP" && rowOf(p.R) && keepRateOf(p.R, p.to) == null) {
      refusals.push(`Keeping the price needs the rate Room ${no(p.R)} was priced at, and this booking has none recorded — choose "at the new dates"`);
    }
  }
  if (movedMode === "NEW_DATES" && !input.guestAgreedNote?.trim()) notes.push("Pricing the night at the new dates needs the guest's agreement — type what they said");
  const priorDiscount = (priorTerms?.requestedDiscount ?? null) as { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
  const carriedDiscount = priorDiscount?.discountPercent ? { discountPercent: priorDiscount.discountPercent, discountBasis: priorDiscount.discountBasis } : null;
  if (priorDiscount?.discountAmount) notes.push("The booking's flat discount stays with this booking — it was agreed on the whole stay");

  // The stays that leave the booking: each moved run, and each run left at its own dates — each a
  // stay of its own, with its rooms night by night.
  let keptNights: string[] | null = null;
  type Spec = { kind: "MOVED" | "LEFT"; picture: NightPicture; segs: Seg[] };
  const specs: Spec[] = [];
  if (single || mixed) {
    const leftPics: NightPicture[] = mixed
      ? mixedStays.slice(1).map((st) => st.picture)
      : runsOf(allNights.filter((d) => !movedAll.has(d)))
          .slice(1)
          .map((run) => picture.filter((n) => run.includes(n.date)).map((n) => ({ date: n.date, roomIds: [...n.roomIds] })));
    keptNights = mixed ? (keptStay?.picture.map((n) => n.date) ?? []) : (runsOf(allNights.filter((d) => !movedAll.has(d)))[0] ?? []);
    for (const pic of leftPics) {
      const ids = Array.from(new Set(pic.flatMap((n) => n.roomIds)));
      specs.push({
        kind: "LEFT",
        picture: pic,
        segs: ids.map((id) => {
          const ns = pic.filter((n) => n.roomIds.includes(id)).map((n) => n.date);
          return { kind: "LEFT", src: id, roomId: id, nights: ns, srcNights: ns, shift: 0 };
        }),
      });
    }
    // Moved nights that follow one another are one stay.
    for (const run of runsOf(picks.flatMap((p) => p.movedNew))) {
      const at = picks.filter((p) => p.movedNew.some((d) => run.includes(d)));
      specs.push({
        kind: "MOVED",
        picture: run.map((date) => ({ date, roomIds: picks.filter((p) => p.movedNew.includes(date)).map((p) => p.to) })),
        segs: at.map((p) => ({
          kind: "MOVED",
          src: p.R,
          roomId: p.to,
          nights: p.movedNew.filter((d) => run.includes(d)),
          srcNights: p.moved.filter((d) => run.includes(shiftIsoDate(d, shiftDays))),
          shift: shiftDays,
        })),
      });
    }
  } else {
    // Some rooms of a booking whose rooms are the same every night: they leave, each stay of theirs a
    // booking, and stays on the same dates one booking holding all their rooms.
    const segs: Seg[] = [];
    for (const p of picks) {
      for (const run of runsOf(p.rNights.filter((d) => !p.moved.includes(d)))) {
        segs.push({ kind: "LEFT", src: p.R, roomId: p.R, nights: run, srcNights: run, shift: 0 });
      }
      segs.push({ kind: "MOVED", src: p.R, roomId: p.to, nights: p.movedNew, srcNights: p.moved, shift: shiftDays });
    }
    const byDates = new Map<string, Seg[]>();
    for (const s of segs) byDates.set(s.nights.join("|"), [...(byDates.get(s.nights.join("|")) ?? []), s]);
    for (const list of byDates.values()) {
      specs.push({
        kind: list.some((s) => s.kind === "MOVED") ? "MOVED" : "LEFT",
        picture: list[0].nights.map((date) => ({ date, roomIds: list.map((s) => s.roomId) })),
        segs: list,
      });
    }
  }
  const segs = specs.flatMap((sp) => sp.segs);
  for (const s of segs) {
    if (s.kind === "LEFT" && rowOf(s.src) && pricedAt(s.src) == null && rowOf(s.src)?.negotiatedRoomRate == null) {
      notes.push(`Room ${no(s.src)} has no rate recorded, so the stays left at their own dates are priced at the published rate`);
    }
  }
  /** A stay left at its own dates keeps its rate, when it has one. */
  const leftMode = (src: string): PriceMode => (keepRateOf(src, src) == null ? "NEW_DATES" : "KEEP");
  const segMode = (s: Seg, m: PriceMode): PriceMode => (s.kind === "MOVED" ? m : leftMode(s.src));
  const segWords = (list: Seg[]) => {
    const same = list.every((s) => s.srcNights.join("|") === list[0].srcNights.join("|"));
    return same
      ? `${roomsWords(list.map((s) => s.src), no)} (${nightsLabel(list[0].srcNights)})`
      : list.map((s) => `Room ${no(s.src)} (${nightsLabel(s.srcNights)})`).join(" + ");
  };

  const note = input.guestAgreedNote?.trim() || null;
  const pieces: NightPiece[] = specs
    .map(({ kind, picture: pic, segs: list }): NightPiece => {
      const nights = pic.map((n) => n.date);
      const comps = (m: PriceMode) => list.map((s) => rowFor(s.src, s.srcNights, s.shift, s.roomId, segMode(s, m))).filter(Boolean) as RoomCompositionServiceInput[];
      return {
        kind,
        picture: pic,
        ...spanOf(nights),
        party: single
          ? whole
          : mixed && kind === "LEFT"
            ? partyWhere((_r, k) => presentOn(pic[0]).includes(k))
            : partyOf(new Set(list.map((s) => s.src))),
        compositions: comps(movedMode),
        rooms: list.map((s) => ({ fromRoomId: s.src, fromRoomNumber: no(s.src), roomId: s.roomId, roomNumber: no(s.roomId), priceMode: segMode(s, movedMode) })),
        words: segWords(list),
        allKept: kind === "MOVED" ? movedMode === "KEEP" : true,
        guestAgreedNote: kind === "MOVED" ? note : null,
        alt: kind === "MOVED" ? { keep: comps("KEEP"), fresh: comps("NEW_DATES") } : null,
      };
    })
    .sort((a, c) => a.checkIn.localeCompare(c.checkIn));
  const movedPieces = pieces.filter((p) => p.kind === "MOVED");

  if (rows.length > 0) for (const p of pieces) if (p.party.guestCount === 0) refusals.push(`Nobody sleeps in ${p.words} — there is no one to make a booking for`);
  const parties: Array<[string, Party]> = single
    ? [["The guests", whole]]
    : mixed
      ? [...pieces.map((p): [string, Party] => [`The guests of ${p.words}`, p.party]), ["The guests who stay", stays]]
    : [...pieces.map((p): [string, Party] => [`The guests of ${p.words}`, p.party]), ["The guests who stay", stays]];
  const checked = new Set<string>();
  for (const [label, p] of parties) {
    const key = `${p.adultCount}|${p.childAges.join(",")}`;
    if (p.guestCount === 0 || checked.has(key)) continue;
    checked.add(key);
    const { issues } = await validateCapacity(prisma, { adults: p.adultCount, childAges: p.childAges }).catch(() => ({ issues: [] as Array<{ severity: string; message: string }> }));
    for (const i of issues) if (i.severity === "BLOCK") refusals.push(`${label}: ${i.message}`);
  }

  // The moved nights on their new rooms: free, usable, and not a night the booking still holds there.
  /** The (room, night) pairs the original still holds after the move. */
  const keptPairs = new Set<string>(
    mixed
      ? (keptStay?.picture ?? []).flatMap((n) => n.roomIds.map((id) => `${id}|${n.date}`))
      : single
        ? picture.filter((n) => (keptNights ?? []).includes(n.date)).flatMap((n) => n.roomIds.map((id) => `${id}|${n.date}`))
        : picture.flatMap((n) => n.roomIds.filter((id) => !pickedSet.has(id)).map((id) => `${id}|${n.date}`)),
  );
  /** The rooms the booking keeps, in plan order. */
  const keptRooms = mixed
    ? planRooms.filter((id) => (keptStay?.picture ?? []).some((n) => n.roomIds.includes(id)))
    : single
      ? Array.from(new Set(picture.filter((n) => (keptNights ?? []).includes(n.date)).flatMap((n) => n.roomIds)))
      : planRooms.filter((id) => !pickedSet.has(id));
  /** What a mixed booking is left as — priced here, since its walks run one after the other. */
  const keptPlan: DryPlan | null =
    mixed && keptStay && rows.length
      ? (() => {
          const counts: Record<string, number> = {};
          for (const n of keptStay.picture) for (const id of n.roomIds) counts[id] = (counts[id] ?? 0) + 1;
          const nightsOf = new Set(keptStay.picture.map((n) => n.date));
          const span = spanOf(keptStay.picture.map((n) => n.date));
          return {
            compositions: keptRooms
              .map((id) => rowOf(id))
              .filter((r): r is RoomCompositionServiceInput => !!r)
              .map((r) => ({ ...r, nightMealOverrides: (r.nightMealOverrides ?? []).filter((o) => nightsOf.has(String(o.date).slice(0, 10))) })),
            discount: (priorTerms?.requestedDiscount ?? null) as DryPlan["discount"],
            planRoomIds: keptRooms,
            perRoomNightCounts: counts,
            checkIn: `${span.checkIn}T00:00:00.000Z`,
            checkOut: `${span.checkOut}T00:00:00.000Z`,
            keptRoomRate: null,
          };
        })()
      : null;
  const leftPairs = new Set(segs.filter((s) => s.kind === "LEFT").flatMap((s) => s.nights.map((d) => `${s.roomId}|${d}`)));
  const landed = new Map<string, string>();
  for (const p of picks) {
    const clash = p.movedNew.filter((d) => keptPairs.has(`${p.to}|${d}`));
    if (clash.length) refusals.push(`Room ${no(p.to)} stays with this booking on ${nightsLabel(clash)} — drop the night on another room or other dates`);
    const clashLeft = p.movedNew.filter((d) => leftPairs.has(`${p.to}|${d}`));
    if (clashLeft.length) refusals.push(`Room ${no(p.to)} already holds ${nightsLabel(clashLeft)} for this guest — drop the night on another room`);
    const twice = p.movedNew.filter((d) => landed.has(`${p.to}|${d}`));
    if (twice.length) refusals.push(`Rooms ${no(landed.get(`${p.to}|${twice[0]}`)!)} and ${no(p.R)} would both land in Room ${no(p.to)} on ${nightsLabel(twice)}`);
    for (const d of p.movedNew) landed.set(`${p.to}|${d}`, p.R);
    const target = roomById.get(p.to)!;
    if (target.isShadowInventory) refusals.push(`Room ${target.roomNumber} is shadow inventory and cannot be booked`);
    for (const range of foldIsoNightsToRanges(p.movedNew)) {
      try {
        enforceCommittedHoldRoomPhysicallyUsable({
          roomNumber: target.roomNumber,
          isBlocked: target.isBlocked,
          blockedReason: target.blockedReason,
          isUnderMaintenance: target.isUnderMaintenance,
          maintenanceDeadline: target.maintenanceDeadline,
          checkIn: range.startDate,
          checkOut: range.endDate,
        });
        const conflicts = await findRoomBookingConflicts(prisma, { roomIds: [p.to], checkIn: range.startDate, checkOut: range.endDate, excludeEntryId: entry.id });
        enforceNoOverlappingBookingForCommittedHold({ conflicts: conflicts.map((c) => ({ ...c, roomNumber: target.roomNumber })) });
      } catch (e) {
        refusals.push(errorMessage(e));
      }
    }
  }

  // Authority: at Negotiation the change of configuration's rule; from Set up on the FOM's.
  const segmentId = entry.segments[0]?.id ?? null;
  const sent = entry.quotations.some((q) => q.segmentId === segmentId && (q.state === "SENT" || q.state === "ACCEPTED"));
  const needed: "L1" | "L2" = stage === Stage.S2 && !sent ? "L1" : "L2";
  const authority = {
    needed,
    actorLevel: actor.actorLevel,
    ok: needed === "L1" || isFom,
    why:
      needed === "L1"
        ? "Nothing has been sent yet — the desk moves the night itself"
        : stage === Stage.S2
          ? isFom
            ? "A quotation has gone out, so moving a night to other dates is the FOM's — you can do it"
            : "A quotation has gone out — moving a night to other dates needs the FOM"
          : isFom
            ? "From Set up on, moving a night to other dates is the FOM's — you can do it"
            : "From Set up on, moving a night to other dates needs the FOM",
  };

  // The same guest over the same nights twice: with what the booking keeps, between the new
  // bookings, and with the guest's other bookings — each said, and answered by the FOM's move.
  const keptNightSet = new Set(single || mixed ? keptNights ?? [] : allNights);
  const overlapWithOriginal = (p: Piece) => p.picture.map((n) => n.date).filter((d) => keptNightSet.has(d));
  const piecesOverlap = (p: Piece) =>
    pieces.filter((q) => q !== p && q.picture.some((n) => p.picture.some((m) => m.date === n.date))).map((q) => q.words);
  const guestOthers: Array<{ entryId: string; checkIn: string; checkOut: string }> = [];
  if (entry.guestProfileId) {
    const first = pieces[0]?.checkIn;
    const last = pieces.reduce((m, p) => (p.checkOut > m ? p.checkOut : m), pieces[0]?.checkOut ?? "");
    if (first && last) {
      for (const o of await prisma.entry.findMany({
        where: {
          id: { not: entry.id },
          status: { in: ["ACTIVE", "PARKED"] },
          OR: [{ guestProfileId: entry.guestProfileId }, { inquiry: { guestProfileId: entry.guestProfileId } }],
          checkInDate: { lt: new Date(`${last}T00:00:00.000Z`) },
          checkOutDate: { gt: new Date(`${first}T00:00:00.000Z`) },
        },
        select: { id: true, checkInDate: true, checkOutDate: true },
      })) {
        if (o.checkInDate && o.checkOutDate) guestOthers.push({ entryId: o.id, checkIn: iso(o.checkInDate), checkOut: iso(o.checkOutDate) });
      }
    }
  }
  const othersOver = (p: Piece) => guestOthers.filter((o) => o.checkIn < p.checkOut && o.checkOut > p.checkIn).map((o) => `${o.entryId} (${fmtDay(o.checkIn)} – ${fmtDay(o.checkOut)})`);
  const overlapsOf = new Map<Piece, string | null>(
    pieces.map((p) => {
      const words = [
        ...(overlapWithOriginal(p).length ? [`${entry.id} itself (${nightsLabel(overlapWithOriginal(p))})`] : []),
        ...piecesOverlap(p).map((w) => `the new booking for ${w}`),
        ...othersOver(p),
      ];
      return [p, words.length ? words.join(", ") : null];
    }),
  );
  for (const p of pieces) {
    const w = overlapsOf.get(p);
    if (w) notes.push(`The guest also holds ${w} over the nights of ${p.words} — the move records the second booking as on purpose.`);
  }
  /** The kept nights overlap a new booking — the original's own walk asks Policy 13 of them. */
  const originalOverlap = pieces.some((p) => overlapWithOriginal(p).length > 0);
  /** A new enquiry is checked against the guest's bookings over the moved nights (Policy 12). */
  const inquiryOverlap = movedPieces.some((mp) => (mp.checkIn < iso(b.priorOut) && mp.checkOut > iso(b.priorIn)) || othersOver(mp).length > 0);
  /** The new enquiry's own dates: the moved nights, first to last. */
  const movedSpan = {
    checkIn: movedPieces.reduce((m, p) => (p.checkIn < m ? p.checkIn : m), movedPieces[0]?.checkIn ?? ""),
    checkOut: movedPieces.reduce((m, p) => (p.checkOut > m ? p.checkOut : m), movedPieces[0]?.checkOut ?? ""),
  };

  return {
    single, mixed, allPicked, pickedSet, keptNights, keptRooms, keptRemoveRooms, keptPicture: keptStay?.picture ?? null, keptPlan, pieces, movedPieces, movedSpan, leaving, stays, rows, priorTerms,
    carriedDiscount, movedMode, authority, overlapsOf, originalOverlap, inquiryOverlap, allNights,
  };
}

/** "Room 206 → 305 (22 Oct)" for every room that moves, the dragged one first. */
const movesWords = (b: Base, toNew: boolean) =>
  b.picks
    .map((p) => `Room ${b.no(p.R)}${p.to !== p.R ? ` → ${b.no(p.to)}` : ""} (${nightsLabel(toNew ? p.movedNew : p.moved)})`)
    .join(" · ");

export async function previewNightMove(prisma: PrismaClient, actor: Actor, input: NightMoveRequest): Promise<NightMovePreview> {
  const b = await planNightMove(prisma, actor, input);
  const { entry, stage, no, refusals, notes } = b;
  const stageWord = STAGE_WORD[String(stage)] ?? String(stage);
  const head = {
    entryId: entry.id,
    bookingLabel: `${entry.id}${b.guest ? ` (${b.guest})` : ""}`,
    guestName: b.guest,
    inquiryId: entry.inquiryId,
    stage: String(stage),
    stageWord,
    from: { roomId: b.R, roomNumber: no(b.R), nightsLabel: nightsLabel(b.moved), nights: b.moved.length },
    to: {
      roomId: b.toRoomId,
      roomNumber: no(b.toRoomId),
      nightsLabel: nightsLabel(b.movedNew),
      ...(() => {
        const s = spanOf(b.movedNew);
        return { checkInDate: s.checkIn, checkOutDate: s.checkOut };
      })(),
      nights: b.movedNew.length,
      sameType: b.sameType,
    },
    moves: b.picks.map((p) => ({
      fromRoomId: p.R,
      fromRoomNumber: no(p.R),
      fromLabel: nightsLabel(p.moved),
      toRoomId: p.to,
      toRoomNumber: no(p.to),
      toLabel: nightsLabel(p.movedNew),
      nights: p.moved.length,
      sameType: p.sameType,
    })),
    shiftDays: b.shiftDays,
  };
  /** A refusal said of one room, when several move. */
  const ofRoom = (p: PickPlan, msg: string) => (b.multi ? `Room ${no(p.R)}: ${msg}` : msg);

  if (b.mode === "ROOM_CHANGE") {
    // Same dates, another room: the room change for those nights.
    const price: NightMovePreview["price"] = { currency: b.currency, choice: null };
    let priceAfter: number | null = null;
    let originalNote: string | null = null;
    const isFomOrSame = b.sameTypeAll || b.isFom;
    if (input.priceMode === "NEW_TYPE" && !b.sameTypeAll && !input.guestAgreedNote?.trim()) notes.push("Pricing it at the new room type needs the guest's agreement — type what they said");
    // The booking's rooms on each night after the move: no room twice on a night.
    const pickOf = new Map(b.picks.map((p) => [p.R, p]));
    for (const n of b.picture) {
      // Who ends up in each room that night: a room the booking keeps, or the picks landing in it.
      const into = new Map<string, string[]>();
      for (const id of n.roomIds) {
        const p = pickOf.get(id);
        const dest = p && p.moved.includes(n.date) ? p.to : id;
        into.set(dest, [...(into.get(dest) ?? []), id]);
      }
      for (const [dest, from] of into) {
        if (from.length < 2) continue;
        const kept = from.includes(dest);
        refusals.push(
          kept
            ? `Room ${no(dest)} is already part of this booking on ${fmtDay(n.date)}`
            : `Rooms ${from.map(no).join(" and ")} would both land in Room ${no(dest)} on ${fmtDay(n.date)}`,
        );
      }
    }
    if (stage === Stage.S2) {
      originalNote = "At Negotiation the booking is priced again at the table — the quotation on file is retired";
      for (const p of b.picks) {
        if (p.to === p.R) continue;
        const target = p.toRoom;
        for (const range of foldIsoNightsToRanges(p.moved)) {
          try {
            enforceCommittedHoldRoomPhysicallyUsable({
              roomNumber: target.roomNumber,
              isBlocked: target.isBlocked,
              blockedReason: target.blockedReason,
              isUnderMaintenance: target.isUnderMaintenance,
              maintenanceDeadline: target.maintenanceDeadline,
              checkIn: range.startDate,
              checkOut: range.endDate,
            });
            const conflicts = await findRoomBookingConflicts(prisma, { roomIds: [p.to], checkIn: range.startDate, checkOut: range.endDate, excludeEntryId: entry.id });
            enforceNoOverlappingBookingForCommittedHold({ conflicts: conflicts.map((c) => ({ ...c, roomNumber: target.roomNumber })) });
          } catch (e) {
            refusals.push(errorMessage(e));
          }
        }
      }
    } else if (refusals.length === 0) {
      const runDry = (p: PickPlan, m: "KEEP" | "NEW_TYPE") =>
        changeRoomToNewSegment(prisma, actor, {
          entryId: entry.id,
          fromRoomId: p.R,
          reason: input.reason?.trim() || "Preview",
          ...roomChangeForm(b, p),
          moveContext: moveContextOf(m, input.guestAgreedNote?.trim() || null),
          dryRun: true,
        });
      /** Every room's walk, dry — the figure they end on, or null when one refuses. */
      const runAll = async (m: "KEEP" | "NEW_TYPE", report: boolean): Promise<number | null> => {
        const drys: RoomChangeOutcome[] = [];
        for (const p of b.picks) {
          try {
            drys.push(await runDry(p, m));
          } catch (e) {
            if (report) refusals.push(ofRoom(p, errorMessage(e)));
            return null;
          }
        }
        const plan = drys.length === 1 ? drys[0].plan ?? null : combinePlans(drys, b.picks);
        return pricePlan(prisma, entry.id, plan).catch(() => null);
      };
      const chosen: "KEEP" | "NEW_TYPE" = input.priceMode === "NEW_TYPE" ? "NEW_TYPE" : "KEEP";
      priceAfter = await runAll(chosen, true);
      if (!b.sameTypeAll && refusals.length === 0) {
        const other = await runAll(chosen === "KEEP" ? "NEW_TYPE" : "KEEP", false);
        price.choice = { kind: "TYPE", keep: chosen === "KEEP" ? priceAfter : other, other: chosen === "KEEP" ? other : priceAfter };
      }
    }
    const nightsWord = b.multi ? "their nights" : b.moved.length === 1 ? "that night" : "those nights";
    const path =
      stage === Stage.S2
        ? [`${movesWords(b, false)} — the configuration changes inside the pass`, "The quotation on file is retired — price the table again at Negotiation"]
        : [
            b.multi
              ? `One walk per room, in turn: ${movesWords(b, false)} — each a new pass`
              : `A new pass: Room ${no(b.toRoomId)} for ${nightsWord}, Room ${no(b.R)} for the rest`,
            "Priced again silently, held again, re-reserved with a new voucher held for you",
            ...(b.multi ? ["If one room's walk is refused, the rooms before it stay moved and the rest do not run — the result says which"] : []),
            `Back at ${stageWord}`,
          ];
    return {
      ok: refusals.length === 0 && isFomOrSame,
      mode: "ROOM_CHANGE",
      ...head,
      original: { words: `Stays on ${entry.id}`, guests: "", priceBefore: b.priceBefore, priceAfter, note: originalNote },
      pieces: [],
      price,
      authority: {
        needed: b.sameTypeAll ? "L1" : "L2",
        actorLevel: actor.actorLevel,
        ok: isFomOrSame,
        why: b.sameTypeAll
          ? "The same room type — the desk changes it"
          : b.isFom
            ? "Another room type — the FOM's to do, and you can"
            : "Another room type re-prices the stay — it needs the FOM",
      },
      targets: null,
      path,
      notes: [...new Set(notes)],
      refusals: [...new Set(refusals)],
    };
  }

  // Other dates: the stays are cut apart.
  const s = await planSplitNights(prisma, actor, b, input);
  const staying = b.planRooms.filter((id) => !s.pickedSet.has(id));
  const price: NightMovePreview["price"] = { currency: b.currency, choice: null };
  let priceAfter: number | null = null;
  let originalNote: string | null = null;
  if (stage === Stage.S2) {
    originalNote = "At Negotiation this booking is priced again at the table — the quotation on file is retired";
  } else if (refusals.length === 0) {
    try {
      const fomHand = b.isFom ? actor : { ...actor, actorLevel: "L2" as const };
      const shortens = (s.keptNights?.length ?? 0) < s.allNights.length;
      const dry = await changeRoomToNewSegment(prisma, fomHand, {
        entryId: entry.id,
        fromRoomId: s.keptRooms[0]!,
        reason: input.reason?.trim() || "Preview",
        ...(s.single || (s.mixed && shortens)
          ? { dateShift: { newCheckInDate: new Date(`${s.keptNights![0]}T00:00:00.000Z`), priceMode: "KEEP" as const, keepNights: s.keptNights } }
          : { splitOff: { roomIds: s.mixed ? s.keptRemoveRooms : [...s.pickedSet], party: s.stays, toLabel: "(preview)" } }),
        dryRun: true,
      });
      priceAfter = await pricePlan(prisma, entry.id, s.mixed ? s.keptPlan : (dry.plan ?? null)).catch(() => null);
    } catch (e) {
      refusals.push(errorMessage(e));
    }
  }
  const priceOf = async (p: Piece, comps: RoomCompositionServiceInput[]): Promise<number | null> => {
    if (!comps.length) return null;
    const counts = new Map<string, number>();
    for (const n of p.picture) for (const id of n.roomIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    const r = await buildQuotationPreview(
      prisma,
      entry.id,
      { roomCompositions: comps as never, discount: s.carriedDiscount ? { percent: s.carriedDiscount.discountPercent ?? null, amount: null } : null },
      { planRoomIds: [...counts.keys()], stayOverride: { checkIn: new Date(`${p.checkIn}T00:00:00.000Z`), checkOut: new Date(`${p.checkOut}T00:00:00.000Z`), perRoomNightCounts: counts } },
    ).catch(() => null);
    return r?.payable ?? null;
  };
  const pieces: NightMovePreview["pieces"] = [];
  for (const p of s.pieces) {
    const roomNumbers = p.rooms.map((r) => r.roomNumber);
    pieces.push({
      kind: p.kind,
      roomNumber: roomNumbers.join(" + "),
      roomNumbers,
      checkInDate: p.checkIn,
      checkOutDate: p.checkOut,
      nights: p.picture.length,
      nightsLabel: nightsLabel(p.picture.map((n) => n.date)),
      guests: partyWords(p.party),
      total: await priceOf(p, p.compositions),
    });
  }
  // The price choice: the moved stays kept at the agreed rate, or priced at the new dates.
  const sumOf = async (which: "keep" | "fresh"): Promise<number | null> => {
    let total = 0;
    for (const p of s.movedPieces) {
      const v = p.alt ? await priceOf(p, p.alt[which]) : null;
      if (v == null) return null;
      total += v;
    }
    return Number(total.toFixed(2));
  };
  price.choice = { kind: "DATES", keep: await sumOf("keep"), other: await sumOf("fresh") };

  const keepsWords = s.single || s.mixed
    ? `${roomsWords(s.keptRooms, no)} for ${nightsLabel(s.keptNights ?? [])}`
    : `${roomsWords(staying, no)} for ${nightsLabel(b.picture.map((n) => n.date))}`;
  const piecesWords = s.pieces.map((p) => `${roomsWords(p.rooms.map((r) => r.roomId), no)} on ${nightsLabel(p.picture.map((n) => n.date))}`);
  const twoSteps = s.mixed && s.keptRemoveRooms.length > 0 && (s.keptNights?.length ?? 0) < s.allNights.length;
  const sourcePath =
    stage === Stage.S2
      ? `This booking keeps ${keepsWords} — its configuration changes inside the pass, and its quotation is retired to price again`
      : `This booking keeps ${keepsWords} — ${twoSteps ? `two passes, one after the other (the stay shortened, then ${roomsWords(s.keptRemoveRooms, no)} out)` : "a new pass"}, re-quoted, re-held, ${stage === Stage.S3 ? "back at Set up" : `re-reserved with a new voucher held for you, back at ${stageWord}`}`;
  const sameEnquiry = {
    path: [
      sourcePath,
      `${s.pieces.length === 1 ? "A new booking" : `${s.pieces.length} new bookings`} under the same enquiry (${entry.inquiryId}) — the same guest: ${piecesWords.join(" · ")}`,
      ...(b.multi ? ["Stays that leave on the same dates are one booking holding all their rooms"] : []),
      stage === Stage.S2
        ? "Each is priced with what the rooms carry and waits at Negotiation"
        : `Each is priced, set up with this booking's payer and cancellation terms, held${stage === Stage.S3 ? "" : " and reserved"} — walked to ${stage === Stage.S5 ? "Reserve, and Arrival when its window is open" : stageWord}`,
      "Where a step needs something only the desk can give — an advance to take, an answer to record — it stops there and says so",
    ],
    papers: stage === Stage.S2 ? [] : [stage === Stage.S3 ? "Each booking gets a proforma invoice — held for you to send or not" : "Each booking gets a confirmation voucher with its own number — held for you to send or not"],
    refusals: [] as string[],
  };
  const newEnquiry = {
    path: [
      sourcePath,
      `One new enquiry with its own number — the same guest, caller, agency and rate package — holding ${s.pieces.length === 1 ? "the new booking" : `the ${s.pieces.length} new bookings`}`,
      `${s.pieces.length === 1 ? "It starts" : "Each starts"} at Inquiry, filled in: ${piecesWords.join(" · ")}`,
      "Each step after fills itself from what the rooms carried — the Negotiation table with its guests, meals and rate, Set up with the payer",
    ],
    papers: stage === Stage.S2 ? [] : [stage === Stage.S3 ? "This booking's new proforma — held for you" : "This booking's new voucher — held for you"],
    refusals: [] as string[],
  };
  if (s.inquiryOverlap && !b.isFom) newEnquiry.refusals.push("A new enquiry for the same guest over nights they hold needs the FOM to say it is on purpose");
  if (s.mixed) {
    notes.push(`This booking's rooms change between nights, so it keeps its stay up to the night that changes — every other stay becomes a booking of its own`);
  } else if (!s.single) {
    const picked = [...s.pickedSet];
    notes.push(`${roomsWords(picked, no)} and ${picked.length === 1 ? "its" : "their"} guests leave ${entry.id} — a booking cannot have fewer guests on some nights than others`);
  }

  return {
    ok: refusals.length === 0 && s.authority.ok,
    mode: "SPLIT",
    ...head,
    original: {
      words: keepsWords,
      guests: partyWords(s.stays),
      priceBefore: b.priceBefore,
      priceAfter,
      note: originalNote,
    },
    pieces,
    price,
    authority: s.authority,
    targets: { SAME_ENQUIRY: sameEnquiry, NEW_ENQUIRY: newEnquiry },
    path: [],
    notes: [...new Set(notes)],
    refusals: [...new Set(refusals)],
  };
}

export async function executeNightMove(
  prisma: PrismaClient,
  actor: Actor,
  input: NightMoveRequest & { reason: string },
): Promise<NightMoveResult> {
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("A reason is required to move a night");
  const b = await planNightMove(prisma, actor, input);
  const { entry, stage, no } = b;

  if (b.mode === "ROOM_CHANGE") {
    if (b.refusals.length) throw new ValidationError(b.refusals[0]);
    if (input.priceMode === "NEW_TYPE" && !b.sameTypeAll && !input.guestAgreedNote?.trim()) {
      throw new ValidationError("Pricing it at the new room type needs the guest's agreement — type what they said");
    }
    const pickOf = new Map(b.picks.map((p) => [p.R, p]));
    const newPicture = b.picture.map((n) => ({
      date: n.date,
      roomIds: n.roomIds.map((id) => {
        const p = pickOf.get(id);
        return p && p.moved.includes(n.date) ? p.to : id;
      }),
    }));
    for (const n of newPicture) {
      const twice = n.roomIds.find((id, i) => n.roomIds.indexOf(id) !== i);
      if (twice) throw new ValidationError(`Two of this booking's rooms would be Room ${no(twice)} on ${fmtDay(n.date)} — drop them where each has its own room`);
    }
    if (stage === Stage.S2) {
      const search = (await queryAvailability(prisma, entry.id, actor.actorId, actor.actorLevel, {
        checkInDate: iso(b.priorIn),
        checkOutDate: iso(b.priorOut),
        guestCount: entry.guestCount ?? undefined,
      })) as { configuration: { id: string } };
      const amendment = await amendNegotiationConfiguration(prisma, entry.id, actor, {
        rooms: { configurationId: search.configuration.id, perNight: newPicture },
        reason: `${movesWords(b, false)}, on the house chart: ${reason}`,
        expectedVersion: entry.version,
      });
      return { mode: "ROOM_CHANGE", target: null, source: { entryId: entry.id, route: "NEGOTIATION", walk: null, amendment }, walks: [], created: [], newInquiryId: null };
    }
    // One walk per room, in turn. The first refused stops the rest; the rooms before it stay moved.
    const walks: NightMoveResult["walks"] = [];
    let last: RoomChangeOutcome | null = null;
    for (const [i, p] of b.picks.entries()) {
      const words = { fromRoomNumber: no(p.R), toRoomNumber: no(p.to), nightsLabel: nightsLabel(p.moved) };
      try {
        const walk = await changeRoomToNewSegment(prisma, actor, {
          entryId: entry.id,
          fromRoomId: p.R,
          reason: b.multi ? `${reason} (${movesWords(b, false)})` : reason,
          ...roomChangeForm(b, p),
          moveContext: moveContextOf(input.priceMode === "NEW_TYPE" ? "NEW_TYPE" : "KEEP", input.guestAgreedNote?.trim() || null),
        });
        walks.push({ ...words, walk, error: null });
        last = walk;
        if (walk.walk.blocked) break;
      } catch (e) {
        if (i === 0) throw e;
        walks.push({ ...words, walk: null, error: errorMessage(e) });
        break;
      }
    }
    for (const p of b.picks.slice(walks.length)) walks.push({ fromRoomNumber: no(p.R), toRoomNumber: no(p.to), nightsLabel: nightsLabel(p.moved), walk: null, error: "Not run — the room before it did not finish" });
    return { mode: "ROOM_CHANGE", target: null, source: { entryId: entry.id, route: "WALK", walk: last, amendment: null }, walks, created: [], newInquiryId: null };
  }

  // ── Other dates ───────────────────────────────────────────────────────────────────────────────
  const target: SplitTarget = input.target === "NEW_ENQUIRY" ? "NEW_ENQUIRY" : "SAME_ENQUIRY";
  const s = await planSplitNights(prisma, actor, b, input);
  if (b.refusals.length) throw new ValidationError(b.refusals[0]);
  if (!s.authority.ok) throw new ValidationError(s.authority.why);
  if (s.movedMode === "NEW_DATES" && !input.guestAgreedNote?.trim()) {
    throw new ValidationError("Pricing the night at the new dates needs the guest's agreement — type what they said");
  }
  if (target === "NEW_ENQUIRY" && s.inquiryOverlap && !b.isFom) {
    throw new ValidationError("A new enquiry for the same guest over nights they hold needs the FOM to say it is on purpose");
  }
  const roomByIdForStamp = b.roomById as never;
  const staying = b.planRooms.filter((id) => !s.pickedSet.has(id));
  const movedWords = movesWords(b, false);

  // ── 1. Every new booking exists first (each holds nothing yet) ───────────────────────────────
  const made: Array<{ id: string; piece: (typeof s.pieces)[number] }> = [];
  let inquiryId = entry.inquiryId;
  try {
    if (target === "NEW_ENQUIRY") {
      const span = s.movedSpan;
      inquiryId = await createSplitInquiry(prisma, actor, entry, {
        proposedCheckIn: span.checkIn,
        proposedCheckOut: span.checkOut,
        duplicateReason: s.inquiryOverlap
          ? `${movedWords} moved off ${entry.id} to ${fmtDay(span.checkIn)} – ${fmtDay(span.checkOut)} — the guest's own nights, on purpose: ${reason}`
          : null,
      });
    }
    for (const piece of s.pieces) made.push({ id: await createPieceEntry(prisma, actor, entry, inquiryId, piece), piece });
  } catch (e) {
    await abandonPieces(prisma, actor, made.map((m) => m.id), errorMessage(e));
    throw new ValidationError(`The new bookings could not be made: ${errorMessage(e)}`);
  }
  for (const m of made) {
    const words = s.overlapsOf.get(m.piece) ?? null;
    await stampPiece(prisma, actor, {
      newId: m.id,
      inquiryId,
      entry,
      target,
      reason,
      piece: m.piece,
      carriedDiscount: s.carriedDiscount,
      roomById: roomByIdForStamp,
      acknowledge: words && b.isFom ? words : null,
      via: "NIGHT_MOVE",
    });
  }

  // ── 2. The original lets the nights go ───────────────────────────────────────────────────────
  const ids = made.map((m) => m.id);
  const toLabel = `${target === "SAME_ENQUIRY" ? "to" : `on a new enquiry (${inquiryId}),`} ${ids.join(" + ")}`;
  let walk: RoomChangeOutcome | null = null;
  let amendment: NegotiationAmendmentOutcome | null = null;
  let route: "NEGOTIATION" | "WALK" = "WALK";
  let followUp: string | null = null;
  const abandon = async (e: unknown): Promise<never> => {
    await abandonPieces(prisma, actor, ids, errorMessage(e));
    throw e;
  };
  const what = `${movedWords} moved ${b.shiftDays > 0 ? "later" : "earlier"} by ${Math.abs(b.shiftDays)} ${Math.abs(b.shiftDays) === 1 ? "day" : "days"} ${toLabel}`;
  if (stage === Stage.S2) {
    route = "NEGOTIATION";
    try {
      if (s.mixed) {
        const kept = s.keptNights!;
        const span = spanOf(kept);
        const search = (await queryAvailability(prisma, entry.id, actor.actorId, actor.actorLevel, {
          checkInDate: span.checkIn,
          checkOutDate: span.checkOut,
          guestCount: s.stays.guestCount || undefined,
        })) as { configuration: { id: string } };
        const roomsNow = Math.max(...s.keptPicture!.map((n) => n.roomIds.length));
        const sameParty =
          s.stays.adultCount === (entry.adultCount ?? 0) && s.stays.childAges.join(",") === (entry.childAges ?? []).join(",") && roomsNow === (entry.numberOfRooms ?? roomsNow);
        amendment = await amendNegotiationConfiguration(prisma, entry.id, actor, {
          dates: { checkInDate: span.checkIn, checkOutDate: span.checkOut },
          ...(sameParty ? {} : { party: { adultCount: s.stays.adultCount, childCount: s.stays.childCount, childAges: s.stays.childAges, numberOfRooms: roomsNow } }),
          rooms: { configurationId: search.configuration.id, perNight: s.keptPicture! },
          reason: `${what}: ${reason}`,
          expectedVersion: entry.version,
        });
      } else if (s.single) {
        const kept = s.keptNights!;
        const span = spanOf(kept);
        const search = (await queryAvailability(prisma, entry.id, actor.actorId, actor.actorLevel, {
          checkInDate: span.checkIn,
          checkOutDate: span.checkOut,
          guestCount: entry.guestCount ?? undefined,
        })) as { configuration: { id: string } };
        amendment = await amendNegotiationConfiguration(prisma, entry.id, actor, {
          dates: { checkInDate: span.checkIn, checkOutDate: span.checkOut },
          rooms: { configurationId: search.configuration.id, perNight: b.picture.filter((n) => kept.includes(n.date)) },
          reason: `${what}: ${reason}`,
          expectedVersion: entry.version,
        });
      } else {
        const search = (await queryAvailability(prisma, entry.id, actor.actorId, actor.actorLevel, {
          checkInDate: iso(b.priorIn),
          checkOutDate: iso(b.priorOut),
          guestCount: s.stays.guestCount || undefined,
        })) as { configuration: { id: string } };
        amendment = await amendNegotiationConfiguration(prisma, entry.id, actor, {
          party: { adultCount: s.stays.adultCount, childCount: s.stays.childCount, childAges: s.stays.childAges, numberOfRooms: staying.length },
          rooms: { configurationId: search.configuration.id, perNight: b.picture.map((n) => ({ date: n.date, roomIds: n.roomIds.filter((id) => !s.pickedSet.has(id)) })) },
          reason: `${what}: ${reason}`,
          expectedVersion: entry.version,
        });
      }
    } catch (e) {
      await abandon(e);
    }
    if (amendment && !amendment.applied) {
      await abandon(new ValidationError("The change to this booking waits for the FOM's approval — move the night once it is applied"));
    }
  } else {
    try {
      if ((s.single || s.mixed) && s.originalOverlap && b.isFom) {
        // The nights kept share dates with a new booking — the same guest twice, on purpose. The
        // shortened stay's own walk asks Policy 13, so the FOM's move answers it here.
        await prisma.traceEvent.create({
          data: {
            eventType: "MULTI_BOOKING.ACKNOWLEDGED",
            actorId: actor.actorId,
            actorLevel: actor.actorLevel,
            entityType: "Entry",
            entityId: entry.id,
            operation: "ACK",
            timestamp: new Date(),
            stageContext: stage,
            inquiryId: entry.inquiryId,
            entryId: entry.id,
            payload: { entryId: entry.id, note: `A night moved off ${entry.id} by the FOM — the guest keeps both bookings on purpose: ${reason}`, via: "NIGHT_MOVE" },
            createdBy: actor.actorId,
          },
        });
      }
      const shortens = (s.keptNights?.length ?? 0) < s.allNights.length;
      walk = await changeRoomToNewSegment(prisma, actor, {
        entryId: entry.id,
        fromRoomId: s.keptRooms[0]!,
        reason: `${what}: ${reason}`,
        ...(s.single || (s.mixed && shortens)
          ? { dateShift: { newCheckInDate: new Date(`${s.keptNights![0]}T00:00:00.000Z`), priceMode: "KEEP" as const, keepNights: s.keptNights } }
          : { splitOff: { roomIds: s.mixed ? s.keptRemoveRooms : [...s.pickedSet], party: s.stays, toLabel } }),
      });
    } catch (e) {
      await abandon(e);
    }
    // A mixed booking whose kept nights lose a room: the room leaves them in a second pass. The stay is
    // already shortened by then, so a refusal here is said, not undone — the new bookings stand.
    if (s.mixed && s.keptRemoveRooms.length > 0 && (s.keptNights?.length ?? 0) < s.allNights.length) {
      try {
        walk = await changeRoomToNewSegment(prisma, actor, {
          entryId: entry.id,
          fromRoomId: s.keptRooms[0]!,
          reason: `${what}: ${reason}`,
          splitOff: { roomIds: s.keptRemoveRooms, party: s.stays, toLabel },
        });
      } catch (e) {
        followUp = `${entry.id} is shortened to ${nightsLabel(s.keptNights ?? [])}, but ${roomsWords(s.keptRemoveRooms, no)} could not leave it: ${errorMessage(e)} — change ${s.keptRemoveRooms.length === 1 ? "that room" : "those rooms"} from the booking's Rooms tab`;
      }
    }
  }

  // ── 3. Each new booking: its rooms picked for its nights, then walked ────────────────────────
  const created: NightMoveResult["created"] = [];
  for (const m of made) {
    const out = await walkPiece(prisma, actor, {
      entry,
      stage,
      target,
      newId: m.id,
      inquiryId,
      piece: m.piece,
      carriedDiscount: s.carriedDiscount,
      priorTerms: s.priorTerms,
      reason,
    });
    created.push({ ...out, kind: m.piece.kind, roomNumber: m.piece.rooms.map((r) => r.roomNumber).join(" + ") });
  }

  // ── 4. Every booking says what happened ──────────────────────────────────────────────────────
  const now = new Date();
  const payload = {
    fromEntryId: entry.id,
    target,
    newInquiryId: target === "NEW_ENQUIRY" ? inquiryId : null,
    room: { roomNumber: no(b.R), toRoomNumber: no(b.toRoomId) },
    nights: { from: b.moved, to: b.movedNew, label: `${nightsLabel(b.moved)} → ${nightsLabel(b.movedNew)}` },
    moves: b.picks.map((p) => ({ roomNumber: no(p.R), toRoomNumber: no(p.to), label: `${nightsLabel(p.moved)} → ${nightsLabel(p.movedNew)}` })),
    kept: s.single || s.mixed ? { roomNumber: s.keptRooms.map(no).join(" + "), nights: s.keptNights } : null,
    roomLeft: !s.single && !s.mixed,
    roomsLeft: s.single ? [] : s.mixed ? s.keptRemoveRooms.map(no) : [...s.pickedSet].map(no),
    followUp,
    pieces: made.map((m) => ({
      entryId: m.id,
      kind: m.piece.kind,
      roomNumber: m.piece.rooms.map((r) => r.roomNumber).join(" + "),
      checkInDate: m.piece.checkIn,
      checkOutDate: m.piece.checkOut,
    })),
    priceMode: s.movedMode,
    reason,
  };
  await prisma.traceEvent
    .createMany({
      data: [
        {
          eventType: "ENTRY.NIGHTS_SPLIT_OFF",
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          entityType: "Entry",
          entityId: entry.id,
          operation: "UPDATE",
          timestamp: now,
          stageContext: stage,
          inquiryId: entry.inquiryId,
          entryId: entry.id,
          payload: payload as Prisma.InputJsonValue,
          createdBy: actor.actorId,
        },
        ...made.map((m, i) => ({
          eventType: "ENTRY.CREATED_FROM_SPLIT",
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          entityType: "Entry",
          entityId: m.id,
          operation: "CREATE" as const,
          timestamp: now,
          stageContext: Stage.S1,
          inquiryId,
          entryId: m.id,
          payload: {
            fromEntryId: entry.id,
            toEntryId: m.id,
            target,
            nightMove: true,
            kind: m.piece.kind,
            rooms: m.piece.rooms.map((r) => ({ fromRoomNumber: r.fromRoomNumber, toRoomNumber: r.roomNumber })),
            from: { checkInDate: iso(b.priorIn), checkOutDate: iso(b.priorOut) },
            to: { checkInDate: m.piece.checkIn, checkOutDate: m.piece.checkOut },
            guests: partyWords(m.piece.party),
            reason,
            aimedAt: created[i]?.aimedAt ?? null,
            blocked: created[i]?.blocked ?? null,
          } as Prisma.InputJsonValue,
          createdBy: actor.actorId,
        })),
      ],
    })
    .catch(() => {});

  return {
    mode: "SPLIT",
    target,
    source: { entryId: entry.id, route, walk, amendment },
    walks: [],
    created,
    newInquiryId: target === "NEW_ENQUIRY" ? inquiryId : null,
    followUp,
  };
}
