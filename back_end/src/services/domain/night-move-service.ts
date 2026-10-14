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
 * Two shapes, each the governed act its step already has:
 *
 *   - **Same dates, another room** — a room change for those nights: at Negotiation the change of
 *     configuration, from Set up on the room-change walk in its per-night form.
 *   - **Other dates** — the stays are cut apart. The original: at Negotiation the change of
 *     configuration (its dates, or its party and rooms); from Set up to Arrival the walk shortening
 *     the stay (one room) or splitting the room off (several). Each new stay: a booking made under
 *     the enquiry chosen, walked to the original's step or started at Inquiry, as a split does.
 *
 * The preview writes nothing; every refusal is said in words before anything runs.
 */

type NightPriceMode = "KEEP" | "NEW_DATES" | "NEW_TYPE";
export type NightMoveMode = "ROOM_CHANGE" | "SPLIT";

export type NightMoveRequest = {
  entryId: string;
  /** The room whose nights were dragged. */
  fromRoomId: string;
  /** The nights that move, as they are now ("YYYY-MM-DD") — one run of the room's nights. */
  nights: string[];
  /** Where they land; the same room when only the dates change. */
  toRoomId?: string | null;
  /** The first moved night's new date — the same as the first night when only the room changes. */
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
  from: { roomId: string; roomNumber: string; nightsLabel: string; nights: number };
  to: { roomId: string; roomNumber: string; nightsLabel: string; checkInDate: string; checkOutDate: string; nights: number; sameType: boolean };
  shiftDays: number;
  /** What the booking keeps, and its price before and after. */
  original: { words: string; guests: string; priceBefore: number | null; priceAfter: number | null; note: string | null };
  /** Every new booking the move makes (other dates only), in date order. */
  pieces: Array<{
    kind: "MOVED" | "LEFT";
    roomNumber: string;
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
  created: Array<PieceOutcome & { kind: "MOVED" | "LEFT"; roomNumber: string }>;
  newInquiryId: string | null;
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

  const R = input.fromRoomId.trim();
  if (!planRooms.includes(R)) throw new ValidationError("That room is not part of this booking's room plan");
  const toRoomId = input.toRoomId?.trim() || R;
  const roomRows = await prisma.room.findMany({ where: { id: { in: Array.from(new Set([...planRooms, toRoomId])) } }, include: { roomType: true } });
  const roomById = new Map(roomRows.map((r) => [r.id, r]));
  const no = (id: string) => roomById.get(id)?.roomNumber ?? "?";
  if (!roomById.has(toRoomId)) throw new ValidationError("The room to move into is not in the house");

  const rNights = picture.filter((n) => n.roomIds.includes(R)).map((n) => n.date);
  const moved = Array.from(new Set(input.nights.map((d) => String(d).slice(0, 10)))).sort();
  if (moved.length === 0) throw new ValidationError("Name the nights that move");
  for (const d of moved) {
    if (!rNights.includes(d)) throw new ValidationError(`Room ${no(R)} does not hold ${fmtDay(d)} on this booking`);
  }
  if (runsOf(moved).length !== 1) refusals.push("The nights that move must follow one another — move them one run at a time");

  const newFirst = String(input.newFirstNight ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newFirst)) throw new ValidationError("newFirstNight must be a date (YYYY-MM-DD)");
  const shiftDays = Math.round((Date.parse(`${newFirst}T00:00:00.000Z`) - Date.parse(`${moved[0]}T00:00:00.000Z`)) / DAY);
  const mode: NightMoveMode = shiftDays === 0 ? "ROOM_CHANGE" : "SPLIT";
  const movedNew = moved.map((d) => shiftIsoDate(d, shiftDays));
  const fromRoom = roomById.get(R)!;
  const toRoom = roomById.get(toRoomId)!;
  const sameType = toRoom.roomTypeId === fromRoom.roomTypeId;
  if (mode === "ROOM_CHANGE" && toRoomId === R) refusals.push("Nothing moves — drop the night on another room or on other dates");

  // The step the booking is at.
  if (entry.status === "PARKED") refusals.push("This booking is parked — resume it first");
  else if (entry.status !== "ACTIVE") refusals.push("This booking has ended — its rooms are a record now");
  else if (stage === Stage.S1) refusals.push("At Inquiry the rooms are picked on the booking's Inquiry step — change them there");
  else if (stage === Stage.S8 || stage === Stage.S9) refusals.push("The guest has left or is leaving — a stay that has happened does not move");
  else if (mode === "SPLIT" && (stage === Stage.S6 || stage === Stage.S7)) {
    refusals.push("The guest is checking in or in house — a night leaves the stay through Leaving early, not by moving it to other dates");
  }
  const todayIso = iso(hotelTodayUtc());
  if (movedNew[0] < todayIso) refusals.push("The night would land before today at the hotel");
  if (stage === Stage.S7 && moved[0] < todayIso) refusals.push("A night already slept does not move");

  const currency = ((): string | null => {
    const op = resolveOperativeQuotation(entry.quotations, entry.segments[0]?.id ?? null);
    return ((op?.commercialTerms as Record<string, unknown> | null)?.currency as string | undefined) ?? null;
  })();
  const operative = resolveOperativeQuotation(entry.quotations, entry.segments[0]?.id ?? null);
  const priceBefore = operative?.totalAmount != null ? Number(operative.totalAmount) : null;

  return {
    entry, stage, isFom, guest, refusals, notes, priorIn, priorOut, picture, planRooms, R, toRoomId, roomById, no,
    rNights, moved, movedNew, shiftDays, mode, fromRoom, toRoom, sameType, todayIso, currency, priceBefore,
  };
}
type Base = Awaited<ReturnType<typeof planNightMove>>;

/** The room-change walk's per-night form for the nights that move — and the rest of the room's nights kept. */
function roomChangeForm(b: Base): { perNight?: Array<{ date: string; roomId: string }>; toRoomId?: string } {
  const nights = b.stage === Stage.S7 ? b.rNights.filter((d) => d >= b.todayIso) : b.rNights;
  if (nights.every((d) => b.moved.includes(d))) return { toRoomId: b.toRoomId };
  return { perNight: nights.map((date) => ({ date, roomId: b.moved.includes(date) ? b.toRoomId : b.R })) };
}

function moveContextOf(mode: "KEEP" | "NEW_TYPE", note: string | null): RoomMoveWalkContext {
  return { moveId: null, legId: null, partnerEntryId: null, partnerLabel: null, tolerate: [], priceMode: mode, guestAgreedNote: note };
}

/** A room change's figure after the walk: the dry run's plan, priced the way the silent quote will. */
async function priceAfterDryRun(prisma: PrismaClient, entryId: string, dry: RoomChangeOutcome): Promise<number | null> {
  const p = dry.plan;
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

/** Everything the split shape needs, validated once. */
async function planSplitNights(prisma: PrismaClient, actor: Actor, b: Base, input: NightMoveRequest) {
  const { entry, picture, planRooms, R, toRoomId, roomById, no, rNights, moved, movedNew, shiftDays, refusals, notes, stage, isFom } = b;
  const single = planRooms.length === 1;
  if (moved.length === rNights.length) {
    refusals.push(`Every night of Room ${no(R)} would move — drag it without Alt to move the whole room`);
  }
  const shape = (n: { roomIds: string[] }) => [...n.roomIds].sort().join("|");
  if (picture.some((n) => shape(n) !== shape(picture[0]))) {
    refusals.push("This booking's rooms change between nights — a single night moves only when every night has the same rooms");
  }

  // The stays left at their own dates, and the one the booking keeps.
  const remainder = rNights.filter((d) => !moved.includes(d));
  const runs = runsOf(remainder);
  const keptNights = single ? (runs[0] ?? []) : null;
  const leftRuns = single ? runs.slice(1) : runs;
  /** The (room, night) pairs the original still holds after the move. */
  const keptPairs = new Set<string>(
    single ? (keptNights ?? []).map((d) => `${R}|${d}`) : picture.flatMap((n) => n.roomIds.filter((id) => id !== R).map((id) => `${id}|${n.date}`)),
  );
  const leftPairs = new Set(leftRuns.flatMap((run) => run.map((d) => `${R}|${d}`)));

  // The moved nights on their new room: free, usable, and not a night the booking still holds there.
  const clash = movedNew.filter((d) => keptPairs.has(`${toRoomId}|${d}`));
  if (clash.length) refusals.push(`Room ${no(toRoomId)} stays with this booking on ${nightsLabel(clash)} — drop the night on another room or other dates`);
  const clashLeft = movedNew.filter((d) => leftPairs.has(`${toRoomId}|${d}`));
  if (clashLeft.length) refusals.push(`Room ${no(toRoomId)} already holds ${nightsLabel(clashLeft)} for this guest — drop the night on another room`);
  const target = roomById.get(toRoomId)!;
  if (target.isShadowInventory) refusals.push(`Room ${target.roomNumber} is shadow inventory and cannot be booked`);
  for (const range of foldIsoNightsToRanges(movedNew)) {
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
      const conflicts = await findRoomBookingConflicts(prisma, { roomIds: [toRoomId], checkIn: range.startDate, checkOut: range.endDate, excludeEntryId: entry.id });
      enforceNoOverlappingBookingForCommittedHold({ conflicts: conflicts.map((c) => ({ ...c, roomNumber: target.roomNumber })) });
    } catch (e) {
      refusals.push(errorMessage(e));
    }
  }

  // Who sleeps in the room — the booking's own seating decides who goes with its nights.
  const basis = resolveCompositionBasis<RoomCompositionServiceInput>(entry);
  const rows = basis.compositions ?? [];
  const rRow = rows.find((r) => r.roomId === R) ?? null;
  if (rows.length === 0) refusals.push("This booking has no record of who sleeps in which room — set the rooms' guests at Negotiation first");
  else if (!rRow) refusals.push(`Room ${no(R)} has no guests recorded on the booking — set them at Negotiation first`);
  const bundle = await loadChildPolicyBundle(prisma).catch(() => null);
  const slots = derivePartySlots(entry, { youngChildMaxAge: bundle?.ageBands.youngChildMaxAge ?? 5, childMaxAge: bundle?.ageBands.childMaxAge ?? 10 });
  const seating = seatPartyRooms({ slots, rows, order: planRoomOrder(picture), nightsByRoom: nightsByRoomFromPicture(picture) });
  const childAges = entry.childAges ?? [];
  const leaving: Party = { adultCount: 0, childCount: 0, childAges: [], guestCount: 0 };
  const stays: Party = { adultCount: 0, childCount: 0, childAges: [], guestCount: 0 };
  for (const slot of slots) {
    const rooms = seating.get(slot.key) ?? [];
    const inR = rooms.includes(R);
    const isChild = slot.key.startsWith("K");
    const age = isChild ? childAges[Number(slot.key.slice(1))] : null;
    for (const side of single ? [leaving, stays] : [inR ? leaving : stays]) {
      if (isChild && typeof age === "number") side.childAges.push(age);
      else side.adultCount += 1;
    }
  }
  for (const p of [leaving, stays]) {
    p.childCount = p.childAges.length;
    p.guestCount = p.adultCount + p.childCount;
  }
  if (rows.length > 0 && leaving.guestCount === 0) refusals.push(`Nobody sleeps in Room ${no(R)} — there is no one to make a booking for`);
  for (const [label, p] of (single ? [["The guests", leaving]] : [["The guests who leave", leaving], ["The guests who stay", stays]]) as Array<[string, Party]>) {
    if (p.guestCount === 0) continue;
    const { issues } = await validateCapacity(prisma, { adults: p.adultCount, childAges: p.childAges }).catch(() => ({ issues: [] as Array<{ severity: string; message: string }> }));
    for (const i of issues) if (i.severity === "BLOCK") refusals.push(`${label}: ${i.message}`);
  }

  // Each stay's row: the room's own, on its room and nights, priced as chosen.
  const priorTerms = (basis.terms ?? null) as Record<string, unknown> | null;
  const perRoom = ((priorTerms?.compositionTotals ?? null) as { perRoom?: Array<{ roomId?: string; roomRate?: unknown }> } | null)?.perRoom ?? [];
  const pricedAt = (() => {
    const v = perRoom.find((r) => r.roomId === R)?.roomRate;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Number(v.toFixed(2)) : null;
  })();
  const movedMode: PriceMode = input.priceMode === "NEW_DATES" ? "NEW_DATES" : "KEEP";
  const crossType = toRoomId !== R && roomById.get(toRoomId)?.roomTypeId !== roomById.get(R)?.roomTypeId;
  const keepRate = (!crossType ? rRow?.negotiatedRoomRate : null) ?? pricedAt;
  const rowFor = (nights: string[], shift: number, roomId: string, m: PriceMode): RoomCompositionServiceInput | null => {
    if (!rRow) return null;
    const ct = roomId !== R && roomById.get(roomId)?.roomTypeId !== roomById.get(R)?.roomTypeId;
    const base: RoomCompositionServiceInput = {
      ...rRow,
      roomId,
      startDate: undefined,
      endDate: undefined,
      nightMealOverrides: (rRow.nightMealOverrides ?? [])
        .filter((o) => nights.includes(String(o.date).slice(0, 10)))
        .map((o) => ({ ...o, date: shiftIsoDate(String(o.date).slice(0, 10), shift) })),
      ...(ct ? { negotiatedRoomRate: undefined } : {}),
    };
    if (m !== "KEEP") return { ...base, negotiatedRoomRate: ct ? undefined : base.negotiatedRoomRate };
    const rate = (!ct ? rRow.negotiatedRoomRate : null) ?? pricedAt;
    return rate != null ? { ...base, negotiatedRoomRate: rate } : base;
  };
  if (movedMode === "KEEP" && rRow && keepRate == null) {
    refusals.push(`Keeping the price needs the rate Room ${no(R)} was priced at, and this booking has none recorded — choose "at the new dates"`);
  }
  if (movedMode === "NEW_DATES" && !input.guestAgreedNote?.trim()) notes.push("Pricing the night at the new dates needs the guest's agreement — type what they said");
  if (rRow && pricedAt == null && rRow.negotiatedRoomRate == null && leftRuns.length) {
    notes.push(`Room ${no(R)} has no rate recorded, so the stays left at their own dates are priced at the published rate`);
  }
  const priorDiscount = (priorTerms?.requestedDiscount ?? null) as { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
  const carriedDiscount = priorDiscount?.discountPercent ? { discountPercent: priorDiscount.discountPercent, discountBasis: priorDiscount.discountBasis } : null;
  if (priorDiscount?.discountAmount) notes.push("The booking's flat discount stays with this booking — it was agreed on the whole stay");

  const roomWord = `Room ${no(R)}`;
  const movedPiece: Piece & { kind: "MOVED" } = {
    kind: "MOVED",
    picture: movedNew.map((date) => ({ date, roomIds: [toRoomId] })),
    ...spanOf(movedNew),
    party: leaving,
    compositions: [rowFor(moved, shiftDays, toRoomId, movedMode)].filter(Boolean) as RoomCompositionServiceInput[],
    rooms: [{ fromRoomId: R, fromRoomNumber: no(R), roomId: toRoomId, roomNumber: no(toRoomId), priceMode: movedMode }],
    words: `${roomWord} (${nightsLabel(moved)})`,
    allKept: movedMode === "KEEP",
    guestAgreedNote: input.guestAgreedNote?.trim() || null,
  };
  const leftPieces: Array<Piece & { kind: "LEFT" }> = leftRuns.map((run) => ({
    kind: "LEFT",
    picture: run.map((date) => ({ date, roomIds: [R] })),
    ...spanOf(run),
    party: leaving,
    compositions: [rowFor(run, 0, R, keepRate == null ? "NEW_DATES" : "KEEP")].filter(Boolean) as RoomCompositionServiceInput[],
    rooms: [{ fromRoomId: R, fromRoomNumber: no(R), roomId: R, roomNumber: no(R), priceMode: "KEEP" as const }],
    words: `${roomWord} (${nightsLabel(run)})`,
    allKept: true,
    guestAgreedNote: null,
  }));
  const pieces = [movedPiece, ...leftPieces].sort((a, c) => a.checkIn.localeCompare(c.checkIn));

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
  const keptNightSet = new Set(single ? keptNights ?? [] : picture.map((n) => n.date));
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
  const movedSpan = spanOf(movedNew);
  const inquiryOverlap =
    (movedSpan.checkIn < iso(b.priorOut) && movedSpan.checkOut > iso(b.priorIn)) || othersOver(movedPiece).length > 0;

  return {
    single, keptNights, leftRuns, pieces, movedPiece, leaving, stays, rows, rRow, priorTerms, carriedDiscount, movedMode,
    authority, overlapsOf, originalOverlap, inquiryOverlap, crossType, roomWord, rowFor,
  };
}

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
    shiftDays: b.shiftDays,
  };

  if (b.mode === "ROOM_CHANGE") {
    // Same dates, another room: the room change for those nights.
    const price: NightMovePreview["price"] = { currency: b.currency, choice: null };
    let priceAfter: number | null = null;
    let originalNote: string | null = null;
    const isFomOrSame = b.sameType || b.isFom;
    if (input.priceMode === "NEW_TYPE" && !b.sameType && !input.guestAgreedNote?.trim()) notes.push("Pricing it at the new room type needs the guest's agreement — type what they said");
    if (stage === Stage.S2) {
      originalNote = "At Negotiation the booking is priced again at the table — the quotation on file is retired";
      if (b.planRooms.includes(b.toRoomId) && b.picture.some((n) => b.moved.includes(n.date) && n.roomIds.includes(b.toRoomId))) {
        refusals.push(`Room ${no(b.toRoomId)} is already part of this booking on those nights`);
      }
      const target = b.toRoom;
      for (const range of foldIsoNightsToRanges(b.moved)) {
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
          const conflicts = await findRoomBookingConflicts(prisma, { roomIds: [b.toRoomId], checkIn: range.startDate, checkOut: range.endDate, excludeEntryId: entry.id });
          enforceNoOverlappingBookingForCommittedHold({ conflicts: conflicts.map((c) => ({ ...c, roomNumber: target.roomNumber })) });
        } catch (e) {
          refusals.push(errorMessage(e));
        }
      }
    } else if (refusals.length === 0) {
      const runDry = (m: "KEEP" | "NEW_TYPE") =>
        changeRoomToNewSegment(prisma, actor, {
          entryId: entry.id,
          fromRoomId: b.R,
          reason: input.reason?.trim() || "Preview",
          ...roomChangeForm(b),
          moveContext: moveContextOf(m, input.guestAgreedNote?.trim() || null),
          dryRun: true,
        });
      try {
        const chosen = await runDry(input.priceMode === "NEW_TYPE" ? "NEW_TYPE" : "KEEP");
        priceAfter = await priceAfterDryRun(prisma, entry.id, chosen).catch(() => null);
        if (!b.sameType) {
          const keep = input.priceMode === "NEW_TYPE" ? await runDry("KEEP").then((d) => priceAfterDryRun(prisma, entry.id, d)).catch(() => null) : priceAfter;
          const other = input.priceMode === "NEW_TYPE" ? priceAfter : await runDry("NEW_TYPE").then((d) => priceAfterDryRun(prisma, entry.id, d)).catch(() => null);
          price.choice = { kind: "TYPE", keep, other };
        }
      } catch (e) {
        refusals.push(errorMessage(e));
      }
    }
    const nightsWord = b.moved.length === 1 ? "that night" : "those nights";
    const path =
      stage === Stage.S2
        ? [
            `Room ${no(b.R)} gives up ${nightsLabel(b.moved)} to Room ${no(b.toRoomId)} — the configuration changes inside the pass`,
            "The quotation on file is retired — price the table again at Negotiation",
          ]
        : [
            `A new pass: Room ${no(b.toRoomId)} for ${nightsWord}, Room ${no(b.R)} for the rest`,
            "Priced again silently, held again, re-reserved with a new voucher held for you",
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
        needed: b.sameType ? "L1" : "L2",
        actorLevel: actor.actorLevel,
        ok: isFomOrSame,
        why: b.sameType
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
  const price: NightMovePreview["price"] = { currency: b.currency, choice: null };
  let priceAfter: number | null = null;
  let originalNote: string | null = null;
  if (stage === Stage.S2) {
    originalNote = "At Negotiation this booking is priced again at the table — the quotation on file is retired";
  } else if (refusals.length === 0) {
    try {
      const fomHand = b.isFom ? actor : { ...actor, actorLevel: "L2" as const };
      const dry = await changeRoomToNewSegment(prisma, fomHand, {
        entryId: entry.id,
        fromRoomId: s.single ? b.R : b.planRooms.find((id) => id !== b.R)!,
        reason: input.reason?.trim() || "Preview",
        ...(s.single
          ? { dateShift: { newCheckInDate: new Date(`${s.keptNights![0]}T00:00:00.000Z`), priceMode: "KEEP" as const, keepNights: s.keptNights } }
          : { splitOff: { roomIds: [b.R], party: s.stays, toLabel: "(preview)" } }),
        dryRun: true,
      });
      priceAfter = await priceAfterDryRun(prisma, entry.id, dry).catch(() => null);
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
    pieces.push({
      kind: (p as { kind: "MOVED" | "LEFT" }).kind,
      roomNumber: p.rooms[0]?.roomNumber ?? "?",
      checkInDate: p.checkIn,
      checkOutDate: p.checkOut,
      nights: p.picture.length,
      nightsLabel: nightsLabel(p.picture.map((n) => n.date)),
      guests: partyWords(p.party),
      total: await priceOf(p, p.compositions),
    });
  }
  const keepComp = s.rowFor(b.moved, b.shiftDays, b.toRoomId, "KEEP");
  const freshComp = s.rowFor(b.moved, b.shiftDays, b.toRoomId, "NEW_DATES");
  price.choice = {
    kind: "DATES",
    keep: keepComp ? await priceOf(s.movedPiece, [keepComp]) : null,
    other: freshComp ? await priceOf(s.movedPiece, [freshComp]) : null,
  };

  const keepsWords = s.single
    ? `${s.roomWord} for ${nightsLabel(s.keptNights ?? [])}`
    : `${b.planRooms.filter((id) => id !== b.R).map((id) => `Room ${no(id)}`).join(" + ")} for ${nightsLabel(b.picture.map((n) => n.date))}`;
  const piecesWords = s.pieces.map((p) => `${p.rooms[0]?.roomNumber ? `Room ${p.rooms[0].roomNumber}` : p.words} on ${nightsLabel(p.picture.map((n) => n.date))}`);
  const sourcePath =
    stage === Stage.S2
      ? `This booking keeps ${keepsWords} — its configuration changes inside the pass, and its quotation is retired to price again`
      : `This booking keeps ${keepsWords} — a new pass, re-quoted, re-held, ${stage === Stage.S3 ? "back at Set up" : `re-reserved with a new voucher held for you, back at ${stageWord}`}`;
  const sameEnquiry = {
    path: [
      sourcePath,
      `${s.pieces.length === 1 ? "A new booking" : `${s.pieces.length} new bookings`} under the same enquiry (${entry.inquiryId}) — the same guest, ${partyWords(s.leaving)}: ${piecesWords.join(" · ")}`,
      stage === Stage.S2
        ? "Each is priced with what the room carries and waits at Negotiation"
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
      "Each step after fills itself from what the room carried — the Negotiation table with its guests, meals and rate, Set up with the payer",
    ],
    papers: stage === Stage.S2 ? [] : [stage === Stage.S3 ? "This booking's new proforma — held for you" : "This booking's new voucher — held for you"],
    refusals: [] as string[],
  };
  if (s.inquiryOverlap && !b.isFom) newEnquiry.refusals.push("A new enquiry for the same guest over nights they hold needs the FOM to say it is on purpose");
  if (!s.single) notes.push(`Room ${no(b.R)} and its guests leave ${entry.id} — a booking cannot have fewer guests on some nights than others`);

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
    if (input.priceMode === "NEW_TYPE" && !b.sameType && !input.guestAgreedNote?.trim()) {
      throw new ValidationError("Pricing it at the new room type needs the guest's agreement — type what they said");
    }
    if (stage === Stage.S2) {
      const search = (await queryAvailability(prisma, entry.id, actor.actorId, actor.actorLevel, {
        checkInDate: iso(b.priorIn),
        checkOutDate: iso(b.priorOut),
        guestCount: entry.guestCount ?? undefined,
      })) as { configuration: { id: string } };
      const amendment = await amendNegotiationConfiguration(prisma, entry.id, actor, {
        rooms: {
          configurationId: search.configuration.id,
          perNight: b.picture.map((n) => ({ date: n.date, roomIds: n.roomIds.map((id) => (id === b.R && b.moved.includes(n.date) ? b.toRoomId : id)) })),
        },
        reason: `Room ${no(b.R)} → ${no(b.toRoomId)} on ${nightsLabel(b.moved)}, on the house chart: ${reason}`,
        expectedVersion: entry.version,
      });
      return { mode: "ROOM_CHANGE", target: null, source: { entryId: entry.id, route: "NEGOTIATION", walk: null, amendment }, created: [], newInquiryId: null };
    }
    const walk = await changeRoomToNewSegment(prisma, actor, {
      entryId: entry.id,
      fromRoomId: b.R,
      reason,
      ...roomChangeForm(b),
      moveContext: moveContextOf(input.priceMode === "NEW_TYPE" ? "NEW_TYPE" : "KEEP", input.guestAgreedNote?.trim() || null),
    });
    return { mode: "ROOM_CHANGE", target: null, source: { entryId: entry.id, route: "WALK", walk, amendment: null }, created: [], newInquiryId: null };
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

  // ── 1. Every new booking exists first (each holds nothing yet) ───────────────────────────────
  const made: Array<{ id: string; piece: (typeof s.pieces)[number] }> = [];
  let inquiryId = entry.inquiryId;
  try {
    if (target === "NEW_ENQUIRY") {
      const span = { checkIn: s.movedPiece.checkIn, checkOut: s.movedPiece.checkOut };
      inquiryId = await createSplitInquiry(prisma, actor, entry, {
        proposedCheckIn: span.checkIn,
        proposedCheckOut: span.checkOut,
        duplicateReason: s.inquiryOverlap
          ? `${s.movedPiece.words} moved off ${entry.id} to ${fmtDay(span.checkIn)} – ${fmtDay(span.checkOut)} — the guest's own nights, on purpose: ${reason}`
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
  const abandon = async (e: unknown): Promise<never> => {
    await abandonPieces(prisma, actor, ids, errorMessage(e));
    throw e;
  };
  const what = `${s.roomWord}'s ${nightsLabel(b.moved)} moved to ${nightsLabel(b.movedNew)} ${toLabel}`;
  if (stage === Stage.S2) {
    route = "NEGOTIATION";
    try {
      if (s.single) {
        const kept = s.keptNights!;
        const span = spanOf(kept);
        const search = (await queryAvailability(prisma, entry.id, actor.actorId, actor.actorLevel, {
          checkInDate: span.checkIn,
          checkOutDate: span.checkOut,
          guestCount: entry.guestCount ?? undefined,
        })) as { configuration: { id: string } };
        amendment = await amendNegotiationConfiguration(prisma, entry.id, actor, {
          dates: { checkInDate: span.checkIn, checkOutDate: span.checkOut },
          rooms: { configurationId: search.configuration.id, perNight: kept.map((date) => ({ date, roomIds: [b.R] })) },
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
          party: { adultCount: s.stays.adultCount, childCount: s.stays.childCount, childAges: s.stays.childAges, numberOfRooms: b.planRooms.length - 1 },
          rooms: { configurationId: search.configuration.id, perNight: b.picture.map((n) => ({ date: n.date, roomIds: n.roomIds.filter((id) => id !== b.R) })) },
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
      if (s.single && s.originalOverlap && b.isFom) {
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
      walk = await changeRoomToNewSegment(prisma, actor, {
        entryId: entry.id,
        fromRoomId: s.single ? b.R : b.planRooms.find((id) => id !== b.R)!,
        reason: `${what}: ${reason}`,
        ...(s.single
          ? { dateShift: { newCheckInDate: new Date(`${s.keptNights![0]}T00:00:00.000Z`), priceMode: "KEEP" as const, keepNights: s.keptNights } }
          : { splitOff: { roomIds: [b.R], party: s.stays, toLabel } }),
      });
    } catch (e) {
      await abandon(e);
    }
  }

  // ── 3. Each new booking: its room picked for its nights, then walked ─────────────────────────
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
    created.push({ ...out, kind: m.piece.kind, roomNumber: m.piece.rooms[0]?.roomNumber ?? "?" });
  }

  // ── 4. Every booking says what happened ──────────────────────────────────────────────────────
  const now = new Date();
  const payload = {
    fromEntryId: entry.id,
    target,
    newInquiryId: target === "NEW_ENQUIRY" ? inquiryId : null,
    room: { roomNumber: no(b.R), toRoomNumber: no(b.toRoomId) },
    nights: { from: b.moved, to: b.movedNew, label: `${nightsLabel(b.moved)} → ${nightsLabel(b.movedNew)}` },
    kept: s.single ? { roomNumber: no(b.R), nights: s.keptNights } : null,
    roomLeft: !s.single,
    pieces: made.map((m) => ({ entryId: m.id, kind: m.piece.kind, roomNumber: m.piece.rooms[0]?.roomNumber ?? "?", checkInDate: m.piece.checkIn, checkOutDate: m.piece.checkOut })),
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
            rooms: [{ fromRoomNumber: no(b.R), toRoomNumber: m.piece.rooms[0]?.roomNumber ?? "?" }],
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

  return { mode: "SPLIT", target, source: { entryId: entry.id, route, walk, amendment }, created, newInquiryId: target === "NEW_ENQUIRY" ? inquiryId : null };
}
