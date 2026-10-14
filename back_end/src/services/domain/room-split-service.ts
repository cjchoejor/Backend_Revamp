import type { PrismaClient } from "@prisma/client";
import { Prisma, Stage } from "@prisma/client";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { foldIsoNightsToRanges } from "../../lib/entry-inventory-claim.js";
import { findRoomBookingConflicts } from "../../lib/room-booking-conflicts.js";
import { hotelTodayUtc } from "../../lib/stay-dates.js";
import { resolveOperativeQuotation } from "../../lib/operative-quotation.js";
import { recordHeldDocument } from "../../lib/held-documents.js";
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
import { progressS1ToS2 } from "../../state-machines/s1-state-machine.js";
import { progressS2ToS3 } from "../../state-machines/s2-s3-state-machine.js";
import { runPreArrivalWindowActivationWorker } from "../../workers/w4-pre-arrival-window-activation-worker.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { changeRoomToNewSegment, shiftIsoDate, type RoomChangeOutcome } from "./room-change-service.js";
import { buildQuotationPreview } from "./quotation-preview-service.js";
import { queryAvailability, selectOption } from "./s1-availability-service.js";
import { amendNegotiationConfiguration, type NegotiationAmendmentOutcome } from "./negotiation-amendment-service.js";
import { loadChildPolicyBundle } from "./child-policy-service.js";
import { validateCapacity } from "./capacity-validation-service.js";
import { createEntry } from "./s1-entry-service.js";
import { createInquiry } from "./s1-inquiry-service.js";
import { createQuotation, type RoomCompositionServiceInput } from "./s2-quotation-service.js";
import { placeSpeculativeHold } from "./s2-hold-service.js";
import { ensureProvisionalFolioAndBillingModel } from "./s3-reservation-setup-service.js";
import { recordCancellationDisclosure } from "./s3-cancellation-disclosure-service.js";
import * as s3HoldService from "./s3-hold-service.js";
import { confirmReservation } from "./s4-confirmation-service.js";
import { recordCommunicationAcknowledgement } from "./communication-acknowledgement-service.js";
import { effectiveAllowedBedTypes, type RoomBedType } from "./room-bed-type-service.js";

/**
 * SPLITTING ROOMS OFF TO OTHER DATES (2026-10-14, operator: "move one singular room to another date
 * range without selecting the other rooms with it ... it should be considered as a different entry
 * under the same inquiry ... ask the user if they want the change as a different entry under the
 * same inquiry or a new inquiry itself; if they choose new inquiry, let them start the inquiry from
 * stage one itself, but retain the details it had and use it to autofill the areas as they move
 * through stages to stages").
 *
 * Rulings the same day (asked): a drag moves the room grabbed (more only when picked); a booking
 * made under the same enquiry is walked to the step the original is at, stopping wherever the
 * money rules stop it; nights that still overlap the original's make a booking of their own anyway.
 *
 * Two acts, each the governed one its step already has:
 *
 *   1. **The rooms leave the original.** At Negotiation, the change of configuration (the party and
 *      the rooms, inside the pass — the quotation on file is retired, as for any change there).
 *      From Set up to Arrival, the room-change walk in its split-off form: a new pass, the rooms and
 *      their guests out of the plan, re-quoted silently, re-held, re-reserved with the voucher held
 *      for the desk, back to its step.
 *   2. **A booking of their own.** `createEntry` under the same enquiry, or `createInquiry` +
 *      `createEntry` for a new one — the same guest, the same caller and party (agency, company,
 *      rate package), the rooms' own guests, the rooms picked for the new nights. Under the same
 *      enquiry it is then walked to the original's step: priced with what the rooms carried, Set
 *      up with the original's payer and cancellation terms, held, reserved with its own voucher
 *      held for the desk. A new enquiry stops at Inquiry, filled in; what the rooms carried rides on
 *      `Entry.carryOver` for the desk to fill each later step with.
 *
 * The preview writes nothing. The guests who leave are the ones the booking's own seating puts in
 * the rooms (`seatPartyRooms`) — never a guess at counts.
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };
type PriceMode = "KEEP" | "NEW_DATES";
export type SplitTarget = "SAME_ENQUIRY" | "NEW_ENQUIRY";
const RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
const DAY = 86_400_000;

const STAGE_WORD: Record<string, string> = {
  S1: "Inquiry",
  S2: "Negotiation",
  S3: "Set up",
  S4: "Reserve",
  S5: "Arrival",
  S6: "Check-in",
  S7: "Stay",
  S8: "Check-out",
  S9: "Closed",
  TERMINAL: "ended",
};

export type RoomSplitRequest = {
  entryId: string;
  /** The room whose bar was dragged. */
  fromRoomId: string;
  /** Every room that splits off, old → new (the same room when it keeps its row). */
  roomMap: Record<string, string>;
  /** The booking's check-in moved by the drag, "YYYY-MM-DD" — every room splitting off moves by the same days. */
  newCheckInDate: string;
  /** The price choice for a room not named in `priceModes`. */
  priceMode?: PriceMode;
  /** The price choice per room, keyed by the room as it is now. */
  priceModes?: Record<string, PriceMode> | null;
  guestAgreedNote?: string | null;
  /** Where the rooms go: a booking under the same enquiry, or a new enquiry. */
  target?: SplitTarget;
  reason?: string | null;
};

type Party = { adultCount: number; childCount: number; childAges: number[]; guestCount: number };

export type RoomSplitPreview = {
  ok: boolean;
  entryId: string;
  bookingLabel: string;
  guestName: string | null;
  inquiryId: string;
  stage: string;
  stageWord: string;
  from: { checkInDate: string; checkOutDate: string; nights: number };
  /** The new booking's stay. */
  to: { checkInDate: string; checkOutDate: string; nights: number };
  shiftDays: number;
  /** The rooms that leave: where each goes, its new nights, its guests, and each price choice's figure. */
  moving: Array<{
    roomId: string;
    roomNumber: string;
    toRoomId: string;
    toRoomNumber: string;
    nightsLabel: string;
    sameType: boolean;
    guests: string;
    priceMode: PriceMode;
    keepTotal: number | null;
    newDatesTotal: number | null;
  }>;
  /** The rooms that stay on the booking. */
  staying: Array<{ roomId: string; roomNumber: string; guests: string }>;
  party: { moving: string; staying: string };
  /** The new stay shares nights with the original's. */
  overlap: { nights: number; words: string } | null;
  authority: { needed: "L1" | "L2"; actorLevel: string; ok: boolean; why: string };
  price: {
    currency: string | null;
    /** The original before and after the rooms leave (null when it is priced again at the table). */
    originalBefore: number | null;
    originalAfter: number | null;
    originalNote: string | null;
    /** The new booking, priced on the choices made. */
    newBooking: number | null;
    newBookingNote: string | null;
  };
  targets: Record<SplitTarget, { path: string[]; papers: string[]; refusals: string[] }>;
  notes: string[];
  refusals: string[];
};

export type RoomSplitResult = {
  target: SplitTarget;
  source: { entryId: string; route: "NEGOTIATION" | "WALK"; walk: RoomChangeOutcome | null; amendment: NegotiationAmendmentOutcome | null };
  created: {
    entryId: string;
    inquiryId: string;
    newInquiry: boolean;
    reachedStage: string;
    /** The step the walk was aiming for (the original's). */
    aimedAt: string;
    blocked: { atStep: string; message: string } | null;
    heldDocuments: Array<{ id: string; kind: "CONFIRMATION_VOUCHER" | "PROFORMA"; documentId: string }>;
    quotationId: string | null;
    checkInDate: string;
    checkOutDate: string;
    notes: string[];
  } | null;
  /** Set when the new booking could not be made — the rooms are back to sell, the reason is here. */
  createFailed: string | null;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmtDay = (d: string) => new Date(`${d}T00:00:00.000Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
function nightsLabel(nights: string[]): string {
  return foldIsoNightsToRanges([...new Set(nights)].sort())
    .map((r) => `${fmtDay(iso(r.startDate))} – ${fmtDay(iso(r.endDate))}`)
    .join(" · ");
}
function nightsBetween(a: Date, b: Date): string[] {
  const out: string[] = [];
  for (let t = a.getTime(); t < b.getTime(); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
function errorMessage(e: unknown): string {
  if (e instanceof AppError) return e.body.message;
  return e instanceof Error ? e.message : String(e);
}
function partyWords(p: { adultCount: number; childAges: number[] }): string {
  const parts: string[] = [];
  if (p.adultCount > 0) parts.push(`${p.adultCount} adult${p.adultCount === 1 ? "" : "s"}`);
  if (p.childAges.length > 0) parts.push(`${p.childAges.length} child${p.childAges.length === 1 ? "" : "ren"} (${p.childAges.join(", ")})`);
  return parts.join(" · ") || "nobody";
}

async function loadSource(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      guestProfile: { select: { id: true, firstName: true, lastName: true } },
      inquiry: true,
      segments: { orderBy: { segmentNumber: "desc" } },
      quotations: { orderBy: { createdAt: "desc" } },
      reservation: true,
      reservations: { orderBy: { confirmedAt: "desc" }, select: { segmentId: true, confirmedAt: true, frozenCommercialTerms: true } },
      committedHold: true,
      roomAssignments: { select: { roomId: true } },
      availabilityConfigs: {
        where: { sealedAt: { not: null }, optionSelected: { not: Prisma.DbNull } },
        orderBy: { sealedAt: "desc" },
        take: 1,
      },
      folio: { select: { id: true, billingModel: true } },
      cancellationDisclosure: true,
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}
type Source = Awaited<ReturnType<typeof loadSource>>;

function stageRefusal(entry: { currentStage: Stage; status: string }): string | null {
  if (entry.status === "PARKED") return "This booking is parked — resume it first";
  if (entry.status !== "ACTIVE") return "This booking has ended — its rooms are a record now";
  switch (entry.currentStage) {
    case Stage.S1:
      return "At Inquiry the rooms are picked on the booking's Inquiry step — change them there";
    case Stage.S6:
    case Stage.S7:
      return "The guest is checking in or in house — a room leaves the stay through Leaving early, not by moving it to other dates";
    case Stage.S8:
    case Stage.S9:
      return "The guest has left or is leaving — a stay that has happened does not split";
    default:
      return null;
  }
}

/** Everything the preview and the run both need, validated once. */
async function planSplit(prisma: PrismaClient, actor: Actor, input: RoomSplitRequest) {
  const entry = await loadSource(prisma, input.entryId);
  const refusals: string[] = [];
  const notes: string[] = [];
  const stage = entry.currentStage;
  const guest =
    [entry.guestProfile?.firstName, entry.guestProfile?.lastName].filter(Boolean).join(" ").trim() ||
    [entry.inquiry?.callerFirstName, entry.inquiry?.callerLastName].filter(Boolean).join(" ").trim() ||
    null;

  const stepRefusal = stageRefusal(entry);
  if (stepRefusal) refusals.push(stepRefusal);

  const reservationOfPass = entry.reservation && entry.reservation.segmentId === entry.segments[0]?.id ? entry.reservation : null;
  const priorIn = reservationOfPass?.frozenCheckInDate ?? entry.checkInDate;
  const priorOut = reservationOfPass?.frozenCheckOutDate ?? entry.checkOutDate;
  if (!priorIn || !priorOut) throw new ValidationError("This booking has no stay dates");
  const newIn = new Date(`${input.newCheckInDate.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(newIn.getTime())) throw new ValidationError("newCheckInDate must be a date (YYYY-MM-DD)");
  const shiftDays = Math.round((newIn.getTime() - priorIn.getTime()) / DAY);
  if (shiftDays === 0) refusals.push("The rooms keep the booking's own dates — that is a room change, not a move to other dates");

  // The booking's rooms night by night, from its sealed pick.
  const sealed = entry.availabilityConfigs[0] ?? null;
  const sel = readOptionSelected(sealed?.optionSelected ?? null);
  const picture: NightPicture =
    sel.perNight && sel.perNight.length > 0
      ? sel.perNight.map((n) => ({ date: String(n.date).slice(0, 10), roomIds: [...n.roomIds] }))
      : nightsBetween(priorIn, priorOut).map((date) => ({ date, roomIds: [...sel.distinctRoomIds] }));
  const planRooms = Array.from(new Set(picture.flatMap((n) => n.roomIds)));
  if (!sealed || planRooms.length === 0) refusals.push("No rooms are picked for this booking yet");

  const roomMap = new Map<string, string>();
  for (const [f, t] of Object.entries(input.roomMap ?? {})) {
    const from = f.trim();
    const to = String(t ?? "").trim() || from;
    if (from) roomMap.set(from, to);
  }
  if (roomMap.size === 0) roomMap.set(input.fromRoomId, input.fromRoomId);
  for (const f of roomMap.keys()) {
    if (!planRooms.includes(f)) throw new ValidationError("A room to move is not part of this booking's room plan");
  }
  const staying = planRooms.filter((id) => !roomMap.has(id));
  if (planRooms.length > 0 && staying.length === 0) {
    refusals.push("Every room of the booking would leave — that moves the whole booking to the other dates");
  }
  const targets = [...roomMap.values()];
  if (new Set(targets).size !== targets.length) refusals.push("Two rooms would land in the same room — drop them where each has its own room");

  const roomRows = await prisma.room.findMany({
    where: { id: { in: Array.from(new Set([...planRooms, ...targets])) } },
    include: { roomType: true },
  });
  const roomById = new Map(roomRows.map((r) => [r.id, r]));
  const no = (id: string) => roomById.get(id)?.roomNumber ?? "?";

  // The new booking's nights: each room's own nights, moved by the same days.
  const newPicture: NightPicture = picture
    .filter((n) => n.roomIds.some((id) => roomMap.has(id)))
    .map((n) => ({ date: shiftIsoDate(n.date, shiftDays), roomIds: n.roomIds.filter((id) => roomMap.has(id)).map((id) => roomMap.get(id)!) }));
  const newNights = newPicture.map((n) => n.date).sort();
  const newCheckIn = newNights[0] ?? iso(newIn);
  const newCheckOut = newNights.length ? shiftIsoDate(newNights[newNights.length - 1], 1) : shiftIsoDate(iso(newIn), 1);
  if (newCheckIn < iso(hotelTodayUtc())) refusals.push("The new nights start before today at the hotel");
  const newNightsByRoom = new Map<string, string[]>();
  for (const n of newPicture) for (const id of n.roomIds) newNightsByRoom.set(id, [...(newNightsByRoom.get(id) ?? []), n.date]);

  // Each room on its new nights: physically usable and nobody else's — the booking's own claims on
  // the rooms that leave let go as they move, but a room that STAYS still holds its own nights.
  const stayingNightsOf = new Map<string, Set<string>>();
  for (const n of picture) for (const id of n.roomIds) if (!roomMap.has(id)) stayingNightsOf.set(id, new Set([...(stayingNightsOf.get(id) ?? []), n.date]));
  for (const [roomId, nights] of newNightsByRoom) {
    const room = roomById.get(roomId);
    if (!room) {
      refusals.push("A room to move into is not in the house");
      continue;
    }
    if (room.isShadowInventory) refusals.push(`Room ${room.roomNumber} is shadow inventory and cannot be booked`);
    const keeps = stayingNightsOf.get(roomId);
    const clash = keeps ? nights.filter((d) => keeps.has(d)) : [];
    if (clash.length) refusals.push(`Room ${room.roomNumber} stays with this booking on ${nightsLabel(clash)} — pick another room for those nights`);
    for (const range of foldIsoNightsToRanges([...new Set(nights)].sort())) {
      try {
        enforceCommittedHoldRoomPhysicallyUsable({
          roomNumber: room.roomNumber,
          isBlocked: room.isBlocked,
          blockedReason: room.blockedReason,
          isUnderMaintenance: room.isUnderMaintenance,
          maintenanceDeadline: room.maintenanceDeadline,
          checkIn: range.startDate,
          checkOut: range.endDate,
        });
        const conflicts = await findRoomBookingConflicts(prisma, {
          roomIds: [roomId],
          checkIn: range.startDate,
          checkOut: range.endDate,
          excludeEntryId: entry.id,
        });
        enforceNoOverlappingBookingForCommittedHold({ conflicts: conflicts.map((c) => ({ ...c, roomNumber: room.roomNumber })) });
      } catch (e) {
        refusals.push(errorMessage(e));
      }
    }
  }

  // Who sleeps where — the booking's own seating decides which guests leave with the rooms.
  const basis = resolveCompositionBasis<RoomCompositionServiceInput>(entry);
  const rows = basis.compositions ?? [];
  if (rows.length === 0) {
    refusals.push("This booking has no record of who sleeps in which room — set the rooms' guests at Negotiation first");
  }
  for (const f of roomMap.keys()) {
    if (rows.length > 0 && !rows.some((r) => r.roomId === f)) refusals.push(`Room ${no(f)} has no guests recorded on the booking — set them at Negotiation first`);
  }
  const bundle = await loadChildPolicyBundle(prisma).catch(() => null);
  const slots = derivePartySlots(entry, {
    youngChildMaxAge: bundle?.ageBands.youngChildMaxAge ?? 5,
    childMaxAge: bundle?.ageBands.childMaxAge ?? 10,
  });
  const seating = seatPartyRooms({ slots, rows, order: planRoomOrder(picture), nightsByRoom: nightsByRoomFromPicture(picture) });
  const childAges = entry.childAges ?? [];
  const leaving: Party = { adultCount: 0, childCount: 0, childAges: [], guestCount: 0 };
  const stays: Party = { adultCount: 0, childCount: 0, childAges: [], guestCount: 0 };
  const guestsOfRoom = new Map<string, { adultCount: number; childAges: number[] }>();
  for (const slot of slots) {
    const rooms = seating.get(slot.key) ?? [];
    const inMoving = rooms.filter((r) => roomMap.has(r));
    const inStaying = rooms.filter((r) => !roomMap.has(r));
    if (inMoving.length && inStaying.length) {
      refusals.push(`${slot.label} sleeps in Room ${no(inMoving[0])} and in Room ${no(inStaying[0])} on different nights — move the two rooms together`);
    }
    const side = inMoving.length && !inStaying.length ? leaving : stays;
    const isChild = slot.key.startsWith("K");
    const age = isChild ? childAges[Number(slot.key.slice(1))] : null;
    if (isChild && typeof age === "number") side.childAges.push(age);
    else side.adultCount += 1;
    for (const r of rooms) {
      const g = guestsOfRoom.get(r) ?? { adultCount: 0, childAges: [] };
      if (isChild && typeof age === "number") g.childAges.push(age);
      else g.adultCount += 1;
      guestsOfRoom.set(r, g);
    }
  }
  for (const p of [leaving, stays]) {
    p.childCount = p.childAges.length;
    p.guestCount = p.adultCount + p.childCount;
  }
  if (rows.length > 0 && leaving.guestCount === 0) refusals.push("Nobody sleeps in the rooms that would leave — there is no one to make a booking for");
  for (const [label, p] of [["The guests who leave", leaving], ["The guests who stay", stays]] as const) {
    if (p.guestCount === 0) continue;
    const { issues } = await validateCapacity(prisma, { adults: p.adultCount, childAges: p.childAges }).catch(() => ({ issues: [] as Array<{ severity: string; message: string }> }));
    for (const i of issues) if (i.severity === "BLOCK") refusals.push(`${label}: ${i.message}`);
  }

  // The rooms' rows for the new booking, on their new rooms and nights, each priced as chosen.
  const priorTerms = (basis.terms ?? null) as Record<string, unknown> | null;
  const perRoom = ((priorTerms?.compositionTotals ?? null) as { perRoom?: Array<{ roomId?: string; roomRate?: unknown }> } | null)?.perRoom ?? [];
  const pricedAt = (roomId: string) => {
    const v = perRoom.find((r) => r.roomId === roomId)?.roomRate;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? Number(v.toFixed(2)) : null;
  };
  const modeOf = (roomId: string): PriceMode => input.priceModes?.[roomId] ?? input.priceMode ?? "KEEP";
  const compsFor = (mode: PriceMode | null): RoomCompositionServiceInput[] =>
    rows
      .filter((r) => roomMap.has(r.roomId))
      .map((r) => {
        const to = roomMap.get(r.roomId)!;
        const crossType = to !== r.roomId && roomById.get(to)?.roomTypeId !== roomById.get(r.roomId)?.roomTypeId;
        const base: RoomCompositionServiceInput = {
          ...r,
          roomId: to,
          startDate: undefined,
          endDate: undefined,
          nightMealOverrides: (r.nightMealOverrides ?? []).map((o) => ({ ...o, date: shiftIsoDate(String(o.date).slice(0, 10), shiftDays) })),
          ...(crossType ? { negotiatedRoomRate: undefined } : {}),
        };
        const m = mode ?? modeOf(r.roomId);
        if (m !== "KEEP") return { ...base, negotiatedRoomRate: crossType ? undefined : base.negotiatedRoomRate };
        const rate = (!crossType ? r.negotiatedRoomRate : null) ?? pricedAt(r.roomId);
        return rate != null ? { ...base, negotiatedRoomRate: rate } : base;
      });
  if ([...roomMap.keys()].some((f) => modeOf(f) === "NEW_DATES") && !input.guestAgreedNote?.trim()) {
    notes.push("A room priced at the new dates needs the guest's agreement — type what they said");
  }
  for (const r of rows) {
    if (!roomMap.has(r.roomId) || modeOf(r.roomId) !== "KEEP") continue;
    const to = roomMap.get(r.roomId)!;
    const crossType = to !== r.roomId && roomById.get(to)?.roomTypeId !== roomById.get(r.roomId)?.roomTypeId;
    if (((!crossType ? r.negotiatedRoomRate : null) ?? pricedAt(r.roomId)) == null) {
      refusals.push(`Keeping the price needs the rate Room ${no(r.roomId)} was priced at, and this booking has none recorded — choose "at the new dates" for it`);
    }
  }
  // A percentage off carries to the new booking; a flat amount was agreed on the whole stay and
  // cannot be shared out, so it stays with the original.
  const priorDiscount = (priorTerms?.requestedDiscount ?? null) as { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
  const carriedDiscount = priorDiscount?.discountPercent ? { discountPercent: priorDiscount.discountPercent, discountBasis: priorDiscount.discountBasis } : null;
  if (priorDiscount?.discountAmount) notes.push("The booking's flat discount stays with the original — it was agreed on the whole stay");

  // Authority: at Negotiation the change of configuration's own rule; from Set up on the FOM's.
  const segmentId = entry.segments[0]?.id ?? null;
  const sent = entry.quotations.some((q) => q.segmentId === segmentId && (q.state === "SENT" || q.state === "ACCEPTED"));
  const isFom = (RANK[actor.actorLevel] ?? 0) >= 2;
  const needed: "L1" | "L2" = stage === Stage.S2 && !sent ? "L1" : "L2";
  const authority = {
    needed,
    actorLevel: actor.actorLevel,
    ok: needed === "L1" || isFom,
    why:
      needed === "L1"
        ? "Nothing has been sent yet — the desk splits the rooms off itself"
        : stage === Stage.S2
          ? isFom
            ? "A quotation has gone out, so splitting rooms off is the FOM's — you can do it"
            : "A quotation has gone out — splitting rooms off needs the FOM"
          : isFom
            ? "From Set up on, splitting rooms off is the FOM's — you can do it"
            : "From Set up on, splitting rooms off needs the FOM",
  };

  // The two bookings share nights — the same guest twice over them.
  const oldNights = new Set(picture.map((n) => n.date));
  const shared = newNights.filter((d) => oldNights.has(d));
  const overlap = shared.length
    ? {
        nights: shared.length,
        words: `The new booking shares ${shared.length} night${shared.length === 1 ? "" : "s"} (${nightsLabel(shared)}) with this one — the same guest on both, in different rooms`,
      }
    : null;

  // The guest's OTHER live bookings over the new nights, on any enquiry (2026-10-14, found on the
  // desk: a room split off to a new enquiry was refused at creation because the guest already held
  // an earlier split-off room on those nights). Policy 12 asks this of a new enquiry and Policy 13 of
  // a reservation — both answered here by the split itself, which names them and is the deliberate act.
  const guestOverlaps: Array<{ entryId: string; words: string }> = [];
  if (entry.guestProfileId && newNights.length) {
    const others = await prisma.entry.findMany({
      where: {
        id: { not: entry.id },
        status: { in: ["ACTIVE", "PARKED"] },
        OR: [{ guestProfileId: entry.guestProfileId }, { inquiry: { guestProfileId: entry.guestProfileId } }],
        checkInDate: { lt: new Date(`${newCheckOut}T00:00:00.000Z`) },
        checkOutDate: { gt: new Date(`${newCheckIn}T00:00:00.000Z`) },
      },
      select: { id: true, checkInDate: true, checkOutDate: true },
      orderBy: { checkInDate: "asc" },
    });
    for (const o of others) {
      guestOverlaps.push({
        entryId: o.id,
        words: `${o.id} (${o.checkInDate && o.checkOutDate ? `${fmtDay(iso(o.checkInDate))} – ${fmtDay(iso(o.checkOutDate))}` : "its dates"})`,
      });
    }
  }

  return {
    guestOverlaps,
    entry, stage, guest, refusals, notes, priorIn, priorOut, shiftDays, picture, planRooms, staying, roomMap, roomById, no,
    newPicture, newCheckIn, newCheckOut, newNightsByRoom, leaving, stays, guestsOfRoom, rows, basis, compsFor, modeOf,
    carriedDiscount, priorTerms, authority, overlap, segmentId,
  };
}
type Plan = Awaited<ReturnType<typeof planSplit>>;

function stayingPicture(plan: Plan): NightPicture {
  return plan.picture.map((n) => ({ date: n.date, roomIds: n.roomIds.filter((id) => !plan.roomMap.has(id)) }));
}

export async function previewRoomSplit(prisma: PrismaClient, actor: Actor, input: RoomSplitRequest): Promise<RoomSplitPreview> {
  const plan = await planSplit(prisma, actor, input);
  const { entry, stage, roomMap, no, refusals, notes } = plan;
  const currency = (plan.priorTerms?.currency as string | undefined) ?? null;
  const price: RoomSplitPreview["price"] = {
    currency,
    originalBefore: null,
    originalAfter: null,
    originalNote: null,
    newBooking: null,
    newBookingNote: null,
  };
  const operative = resolveOperativeQuotation(entry.quotations, plan.segmentId);
  price.originalBefore = operative?.totalAmount != null ? Number(operative.totalAmount) : null;

  // The original without the rooms: at Negotiation priced again at the table; from Set up on, the
  // walk dry-run with the FOM's hand so the figures show to the desk too.
  if (stage === Stage.S2) {
    price.originalNote = "At Negotiation the original is priced again at the table — the quotation on file is retired";
  } else if (refusals.length === 0) {
    try {
      const dry = await changeRoomToNewSegment(prisma, (RANK[actor.actorLevel] ?? 0) >= 2 ? actor : { ...actor, actorLevel: "L2" }, {
        entryId: entry.id,
        fromRoomId: plan.staying[0],
        reason: input.reason?.trim() || "Preview",
        splitOff: { roomIds: [...roomMap.keys()], party: plan.stays, toLabel: "(preview)" },
        dryRun: true,
      });
      price.originalBefore = dry.pricing.priorTotal ?? price.originalBefore;
      const p = dry.plan;
      if (p?.compositions) {
        const counts = new Map<string, number>(Object.entries(p.perRoomNightCounts ?? {}));
        const after = await buildQuotationPreview(
          prisma,
          entry.id,
          {
            roomCompositions: p.compositions as never,
            discount: p.discount ? { percent: p.discount.discountPercent ?? null, amount: p.discount.discountAmount ?? null } : null,
          },
          { planRoomIds: p.planRoomIds, stayOverride: { checkIn: new Date(p.checkIn), checkOut: new Date(p.checkOut), perRoomNightCounts: counts } },
        );
        price.originalAfter = after.payable;
      }
    } catch (e) {
      refusals.push(errorMessage(e));
    }
  }

  // The new booking, priced each way and as chosen.
  let keepTotals: Map<string, number> | undefined;
  let freshTotals: Map<string, number> | undefined;
  if (plan.rows.length > 0 && plan.newPicture.length > 0) {
    const counts = new Map<string, number>();
    for (const [id, nights] of plan.newNightsByRoom) counts.set(id, nights.length);
    const priceOf = (comps: RoomCompositionServiceInput[]) =>
      buildQuotationPreview(
        prisma,
        entry.id,
        { roomCompositions: comps as never, discount: plan.carriedDiscount ? { percent: plan.carriedDiscount.discountPercent ?? null, amount: null } : null },
        {
          planRoomIds: [...plan.newNightsByRoom.keys()],
          stayOverride: { checkIn: new Date(`${plan.newCheckIn}T00:00:00.000Z`), checkOut: new Date(`${plan.newCheckOut}T00:00:00.000Z`), perRoomNightCounts: counts },
        },
      );
    try {
      keepTotals = new Map((await priceOf(plan.compsFor("KEEP"))).rooms.map((r) => [r.roomId, r.total]));
      freshTotals = new Map((await priceOf(plan.compsFor("NEW_DATES"))).rooms.map((r) => [r.roomId, r.total]));
      price.newBooking = (await priceOf(plan.compsFor(null))).payable;
    } catch (e) {
      price.newBookingNote = `The new booking's price could not be worked out ahead: ${errorMessage(e)} — its quotation states it`;
    }
  }

  const moving: RoomSplitPreview["moving"] = [...roomMap].map(([f, t]) => {
    const g = plan.guestsOfRoom.get(f) ?? { adultCount: 0, childAges: [] };
    return {
      roomId: f,
      roomNumber: no(f),
      toRoomId: t,
      toRoomNumber: no(t),
      nightsLabel: nightsLabel(plan.newNightsByRoom.get(t) ?? []),
      sameType: plan.roomById.get(t)?.roomTypeId === plan.roomById.get(f)?.roomTypeId,
      guests: partyWords(g),
      priceMode: plan.modeOf(f),
      keepTotal: keepTotals?.get(t) ?? null,
      newDatesTotal: freshTotals?.get(t) ?? null,
    };
  });
  const byNumber = (a: { roomNumber: string }, b: { roomNumber: string }) => a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true });
  moving.sort(byNumber);
  const staying = plan.staying.map((id) => ({ roomId: id, roomNumber: no(id), guests: partyWords(plan.guestsOfRoom.get(id) ?? { adultCount: 0, childAges: [] }) })).sort(byNumber);

  // What each choice does, step by step.
  const stageWord = STAGE_WORD[String(stage)] ?? String(stage);
  const sourcePath =
    stage === Stage.S2
      ? "This booking keeps its other rooms — its configuration changes inside the pass, and its quotation is retired to price again"
      : `This booking keeps its other rooms — a new pass, re-quoted without ${moving.length === 1 ? "the room" : "the rooms"}, re-held, ${stage === Stage.S3 ? "back at Set up" : "re-reserved with a new voucher held for you, back at " + stageWord}`;
  const sameEnquiry: RoomSplitPreview["targets"]["SAME_ENQUIRY"] = {
    path: [
      sourcePath,
      `A new booking under the same enquiry (${entry.inquiryId}) — the same guest, ${partyWords(plan.leaving)}, ${moving.map((m) => `Room ${m.toRoomNumber}`).join(" + ")} on ${nightsLabel(plan.newPicture.map((n) => n.date))}`,
      stage === Stage.S2
        ? "It is priced with what the rooms carry and waits at Negotiation"
        : `It is priced, set up with this booking's payer and cancellation terms, held${stage === Stage.S3 ? "" : " and reserved"} — walked to ${stage === Stage.S5 ? "Reserve, and Arrival when its window is open" : stageWord}`,
      "Where a step needs something only the desk can give — an advance to take, an answer to record — it stops there and says so",
    ],
    papers:
      stage === Stage.S2
        ? []
        : stage === Stage.S3
          ? ["Each booking gets a proforma invoice — held for you to send or not"]
          : ["Each booking gets a confirmation voucher with its own number — held for you to send or not"],
    refusals: [],
  };
  const newEnquiry: RoomSplitPreview["targets"]["NEW_ENQUIRY"] = {
    path: [
      sourcePath,
      "A new enquiry with its own number — the same guest, caller, agency and rate package",
      `Its booking starts at Inquiry, filled in: ${partyWords(plan.leaving)}, ${moving.map((m) => `Room ${m.toRoomNumber}`).join(" + ")} picked on ${nightsLabel(plan.newPicture.map((n) => n.date))}`,
      "Each step after fills itself from what the rooms carried — the Negotiation table with their guests, meals and rates, Set up with the payer",
    ],
    papers: stage === Stage.S2 ? [] : [stage === Stage.S3 ? "This booking's new proforma — held for you" : "This booking's new voucher — held for you"],
    refusals: [],
  };
  const sameGuestOverNights = !!plan.overlap || plan.guestOverlaps.length > 0;
  if (sameGuestOverNights && (RANK[actor.actorLevel] ?? 0) < 2) {
    newEnquiry.refusals.push("A second enquiry for the same guest over nights they already hold needs the FOM to say it is on purpose");
  }
  if (plan.overlap) notes.push(`${plan.overlap.words}. The FOM's split records that it is on purpose.`);
  if (plan.guestOverlaps.length) {
    notes.push(
      `The guest also holds ${plan.guestOverlaps.map((o) => o.words).join(", ")} over these nights — the split records the second booking as on purpose.`,
    );
  }

  const ok = refusals.length === 0 && plan.authority.ok;
  return {
    ok,
    entryId: entry.id,
    bookingLabel: `${entry.id}${plan.guest ? ` (${plan.guest})` : ""}`,
    guestName: plan.guest,
    inquiryId: entry.inquiryId,
    stage: String(stage),
    stageWord,
    from: { checkInDate: iso(plan.priorIn), checkOutDate: iso(plan.priorOut), nights: Math.round((plan.priorOut.getTime() - plan.priorIn.getTime()) / DAY) },
    to: {
      checkInDate: plan.newCheckIn,
      checkOutDate: plan.newCheckOut,
      nights: Math.round((Date.parse(plan.newCheckOut) - Date.parse(plan.newCheckIn)) / DAY),
    },
    shiftDays: plan.shiftDays,
    moving,
    staying,
    party: { moving: partyWords(plan.leaving), staying: partyWords(plan.stays) },
    overlap: plan.overlap,
    authority: plan.authority,
    price,
    targets: { SAME_ENQUIRY: sameEnquiry, NEW_ENQUIRY: newEnquiry },
    notes: [...new Set(notes)],
    refusals: [...new Set(refusals)],
  };
}

export async function executeRoomSplit(
  prisma: PrismaClient,
  actor: Actor,
  input: RoomSplitRequest & { reason: string; target: SplitTarget },
): Promise<RoomSplitResult> {
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("A reason is required to split rooms off to other dates");
  const target: SplitTarget = input.target === "NEW_ENQUIRY" ? "NEW_ENQUIRY" : "SAME_ENQUIRY";
  const plan = await planSplit(prisma, actor, input);
  if (plan.refusals.length) throw new ValidationError(plan.refusals[0]);
  if (!plan.authority.ok) throw new ValidationError(plan.authority.why);
  if ([...plan.roomMap.keys()].some((f) => plan.modeOf(f) === "NEW_DATES") && !input.guestAgreedNote?.trim()) {
    throw new ValidationError("Pricing a room at the new dates needs the guest's agreement — type what they said");
  }
  const isFom = (RANK[actor.actorLevel] ?? 0) >= 2;
  const sameGuestOverNights = !!plan.overlap || plan.guestOverlaps.length > 0;
  if (target === "NEW_ENQUIRY" && sameGuestOverNights && !isFom) {
    throw new ValidationError("A second enquiry for the same guest over nights they already hold needs the FOM to say it is on purpose");
  }
  const overlapWords = [
    ...(plan.overlap ? [`${plan.entry.id} itself`] : []),
    ...plan.guestOverlaps.map((o) => o.words),
  ].join(", ");
  const { entry, stage, roomMap, no } = plan;
  const movedNumbers = [...roomMap.keys()].map(no).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const movedWords = `Room${movedNumbers.length === 1 ? "" : "s"} ${movedNumbers.join(" + ")}`;

  // ── 1. The new booking exists first (it holds nothing yet), so the rooms' guests always have one ──
  let created: { id: string; inquiryId: string } | null = null;
  let createFailed: string | null = null;
  try {
    let inquiryId = entry.inquiryId;
    if (target === "NEW_ENQUIRY") {
      const inq = entry.inquiry;
      const madeInquiry = await createInquiry(prisma, actor.actorId, actor.actorLevel, {
        guestProfileId: entry.guestProfileId ?? null,
        // The caller carries when they can be reached; an older enquiry with none falls back to the
        // guest on file, as it always has.
        caller:
          inq.callerPhone || inq.callerEmail
            ? {
                title: inq.callerTitle ?? null,
                firstName: inq.callerFirstName ?? null,
                lastName: inq.callerLastName ?? null,
                phone: inq.callerPhone ?? null,
                email: inq.callerEmail ?? null,
                onWhatsApp: inq.callerOnWhatsApp ?? null,
              }
            : null,
        sourceChannel: inq.sourceChannel ?? undefined,
        cameInAs: inq.cameInAs ?? undefined,
        notes: inq.notes ?? undefined,
        travelAgentId: inq.travelAgentId ?? null,
        corporateAccountId: inq.corporateAccountId ?? null,
        ratePackageId: inq.ratePackageId ?? null,
        proposedCheckIn: plan.newCheckIn,
        proposedCheckOut: plan.newCheckOut,
        ...(sameGuestOverNights
          ? {
              duplicateResolution: {
                resolution: "ACKNOWLEDGE" as const,
                reason: `Split off ${entry.id} (${movedWords}) to other dates — the guest also holds ${overlapWords} over those nights, on purpose: ${reason}`,
              },
            }
          : {}),
      });
      inquiryId = madeInquiry.id;
    }
    const made = await createEntry(prisma, actor.actorId, actor.actorLevel, {
      inquiryId,
      guestProfileId: entry.guestProfileId ?? undefined,
      useType: entry.useType,
      checkInDate: plan.newCheckIn,
      checkOutDate: plan.newCheckOut,
      adultCount: plan.leaving.adultCount,
      childCount: plan.leaving.childCount,
      childAges: plan.leaving.childAges,
      guestCount: plan.leaving.guestCount,
      numberOfRooms: roomMap.size,
      otaSource: entry.otaSource ?? undefined,
      contactPersonName: entry.contactPersonName ?? undefined,
      contactPersonPhone: entry.contactPersonPhone ?? undefined,
      contactPersonEmail: entry.contactPersonEmail ?? undefined,
    });
    created = { id: made.id, inquiryId };
  } catch (e) {
    createFailed = errorMessage(e);
  }
  if (!created) {
    // Nothing has changed on the original — say why and stop.
    throw new ValidationError(`The new booking could not be made: ${createFailed}`);
  }

  // What the rooms carry, for the desk to fill each later step with.
  const bedPlan = ((entry as { bedPlan?: unknown }).bedPlan ?? null) as Record<string, string> | null;
  const carriedBeds: Record<string, string> = {};
  for (const [f, t] of roomMap) {
    const planned = bedPlan?.[f];
    const room = plan.roomById.get(t);
    if (planned && room && effectiveAllowedBedTypes(room.allowedBedTypes, room.roomType?.allowedBedTypes).includes(planned as RoomBedType)) carriedBeds[t] = planned;
  }
  const chosenComps = plan.compsFor(null);
  const carryOver = {
    fromEntryId: entry.id,
    fromInquiryId: entry.inquiryId,
    at: new Date().toISOString(),
    by: actor.actorId,
    reason,
    target,
    rooms: [...roomMap].map(([f, t]) => ({ fromRoomId: f, fromRoomNumber: no(f), roomId: t, roomNumber: no(t), priceMode: plan.modeOf(f) })),
    compositions: chosenComps,
    discount: plan.carriedDiscount,
    billingModel: entry.folio?.billingModel ?? null,
    cancellation: entry.cancellationDisclosure
      ? { noShowTreatmentStatement: entry.cancellationDisclosure.noShowTreatmentStatement, disclosedTerms: entry.cancellationDisclosure.disclosedTerms }
      : null,
    guestAgreedNote: input.guestAgreedNote?.trim() || null,
  };
  // The same guest over nights they already hold: the FOM's split is the acknowledgement Policy 13
  // asks for at Reserve (2026-10-14, found on the desk — a room split off to a new enquiry was asked
  // again when the desk reserved it by hand). Written now, on the new booking, so whichever step
  // reaches Reserve — the walk, or the desk later — finds it. A front desk's split (Negotiation, nothing
  // sent) leaves it to the FOM at Reserve.
  if (sameGuestOverNights && isFom) {
    await prisma.traceEvent.create({
      data: {
        eventType: "MULTI_BOOKING.ACKNOWLEDGED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Entry",
        entityId: created.id,
        operation: "ACK",
        timestamp: new Date(),
        stageContext: Stage.S1,
        inquiryId: created.inquiryId,
        entryId: created.id,
        payload: {
          entryId: created.id,
          note: `Split off ${entry.id} by the FOM — the guest also holds ${overlapWords} over these nights, on purpose: ${reason}`,
          via: "ROOM_SPLIT",
        },
        createdBy: actor.actorId,
      },
    });
  }
  await prisma.entry.update({
    where: { id: created.id },
    data: {
      splitFromEntryId: entry.id,
      carryOver: carryOver as Prisma.InputJsonValue,
      ...(Object.keys(carriedBeds).length ? { bedPlan: carriedBeds as Prisma.InputJsonValue } : {}),
    },
  });

  // ── 2. The rooms leave the original ──────────────────────────────────────────────────────────
  const toLabel = target === "SAME_ENQUIRY" ? `to ${created.id} on the same enquiry` : `to ${created.id} on a new enquiry (${created.inquiryId})`;
  let walk: RoomChangeOutcome | null = null;
  let amendment: NegotiationAmendmentOutcome | null = null;
  let route: "NEGOTIATION" | "WALK" = "WALK";
  // The original refusing before anything moved leaves the new booking with no reason to exist —
  // it is closed with the refusal as its reason (a record, not a deletion), and the refusal stands.
  const abandon = async (e: unknown): Promise<never> => {
    const message = errorMessage(e);
    const when = new Date();
    await prisma.entry
      .update({
        where: { id: created!.id },
        data: { status: "CANCELLED", closedAs: "CANCELLED", closedReason: `The split did not happen: ${message}`, closedAt: when, closedBy: actor.actorId },
      })
      .catch(() => {});
    await prisma.timerRecord
      .updateMany({
        where: { entryId: created!.id, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledAt: when, cancelledBy: actor.actorId, cancelledReason: "ROOM_SPLIT_REFUSED" },
      })
      .catch(() => {});
    throw e;
  };
  if (stage === Stage.S2) {
    route = "NEGOTIATION";
    try {
    const search = (await queryAvailability(prisma, entry.id, actor.actorId, actor.actorLevel, {
      checkInDate: iso(plan.priorIn),
      checkOutDate: iso(plan.priorOut),
      guestCount: plan.stays.guestCount || undefined,
    })) as { configuration: { id: string } };
    amendment = await amendNegotiationConfiguration(prisma, entry.id, actor, {
      party: {
        adultCount: plan.stays.adultCount,
        childCount: plan.stays.childCount,
        childAges: plan.stays.childAges,
        numberOfRooms: plan.staying.length,
      },
      rooms: { configurationId: search.configuration.id, perNight: stayingPicture(plan) },
      reason: `${movedWords} split off ${toLabel}: ${reason}`,
      expectedVersion: entry.version,
    });
    } catch (e) {
      await abandon(e);
    }
    if (amendment && !amendment.applied) {
      await abandon(new ValidationError("The change to the original waits for the FOM's approval — split the rooms off once it is applied"));
    }
  } else {
    try {
      walk = await changeRoomToNewSegment(prisma, actor, {
        entryId: entry.id,
        fromRoomId: plan.staying[0],
        reason,
        splitOff: { roomIds: [...roomMap.keys()], party: plan.stays, toLabel },
      });
    } catch (e) {
      // Refused before its re-entry — the original is untouched.
      await abandon(e);
    }
  }

  // ── 3. The new booking: its rooms picked for its nights, then walked to the original's step ────
  const createdNotes: string[] = [];
  const heldDocuments: Array<{ id: string; kind: "CONFIRMATION_VOUCHER" | "PROFORMA"; documentId: string }> = [];
  let quotationId: string | null = null;
  let blocked: { atStep: string; message: string } | null = null;
  const aimedAt = target === "NEW_ENQUIRY" ? "S1" : String(stage) === "S5" ? "S5" : String(stage);
  const newId = created.id;
  const version = async () => (await prisma.entry.findUniqueOrThrow({ where: { id: newId }, select: { version: true } })).version;
  const step = async (atStep: string, fn: () => Promise<unknown>): Promise<boolean> => {
    if (blocked) return false;
    try {
      await fn();
      return true;
    } catch (e) {
      blocked = { atStep, message: errorMessage(e) };
      return false;
    }
  };
  const anchor = [...plan.newNightsByRoom.entries()].sort((a, b) => b[1].length - a[1].length)[0]?.[0] ?? [...roomMap.values()][0];

  await step("PICK_ROOMS", async () => {
    const search = (await queryAvailability(prisma, newId, actor.actorId, actor.actorLevel, {
      checkInDate: plan.newCheckIn,
      checkOutDate: plan.newCheckOut,
      guestCount: plan.leaving.guestCount || undefined,
    })) as { configuration: { id: string } };
    await selectOption(prisma, search.configuration.id, actor.actorId, { perNight: plan.newPicture.map((n) => ({ date: n.date, roomIds: n.roomIds })) });
  });

  if (target === "SAME_ENQUIRY") {
    await step("INQUIRY_TO_NEGOTIATION", async () => progressS1ToS2(prisma, newId, actor.actorId, await version()));
    // Priced with what the rooms carried — the discount under the authority that approved it.
    await step("QUOTATION", async () => {
      const approved = ((plan.priorTerms?.discountAuthority as { approvedLevel?: string } | undefined)?.approvedLevel ?? null) as Actor["actorLevel"] | null;
      const level = plan.carriedDiscount && approved && (RANK[approved] ?? 0) > (RANK[actor.actorLevel] ?? 0) ? approved : actor.actorLevel;
      const q = await createQuotation(prisma, newId, actor.actorId, {
        notes: `${movedWords} split off ${entry.id} to ${fmtDay(plan.newCheckIn)} – ${fmtDay(plan.newCheckOut)} (${reason})`,
        roomCompositions: chosenComps,
        ...(plan.carriedDiscount ? { requestedDiscount: plan.carriedDiscount } : {}),
        actorLevel: level,
      });
      quotationId = q.id;
    });
    if (stage !== Stage.S2) {
      // The rooms are marked while the walk runs on, so nobody takes them between the steps; the
      // committed hold takes the marker over at Set up.
      await step("PROVISIONAL_BLOCK", async () => {
        await placeSpeculativeHold(prisma, newId, actor, { roomId: anchor, commercialBasis: `Split off ${entry.id}: ${reason}` }).catch((e) => {
          createdNotes.push(`The rooms were not marked on the way: ${errorMessage(e)}`);
        });
      });
      await step("NEGOTIATION_TO_SET_UP", async () => progressS2ToS3(prisma, newId, actor.actorId, await version()));
      await step("PAYER", async () =>
        ensureProvisionalFolioAndBillingModel(prisma, newId, actor.actorId, actor.actorLevel, { billingModel: entry.folio?.billingModel ?? "GUEST_PAY" }),
      );
      await step("CANCELLATION_TERMS", async () => {
        const seg = await prisma.segment.findFirst({ where: { entryId: newId }, orderBy: { segmentNumber: "desc" }, select: { id: true } });
        const src = entry.cancellationDisclosure;
        if (!src) throw new ValidationError("The original has no cancellation terms recorded to carry — record them at Set up");
        await recordCancellationDisclosure(
          prisma,
          { entryId: newId, segmentId: seg!.id, noShowTreatmentStatement: src.noShowTreatmentStatement, disclosedTerms: src.disclosedTerms },
          actor,
        );
      });
      await step("HOLD", async () =>
        s3HoldService.placeCommittedHold(prisma, newId, actor, { roomId: anchor, commercialJustification: `Split off ${entry.id}: ${reason}` }),
      );
      if (stage === Stage.S3 && !blocked) {
        const folio = await prisma.folio.findUnique({ where: { entryId: newId }, select: { id: true } });
        const proforma = folio
          ? await prisma.invoice.findFirst({ where: { folioId: folio.id, invoiceType: "PROFORMA", state: { not: "SUPERSEDED" } }, orderBy: { createdAt: "desc" }, select: { id: true } })
          : null;
        if (proforma) {
          const held = await recordHeldDocument(prisma, {
            entryId: newId,
            kind: "PROFORMA",
            documentId: proforma.id,
            reason: "ROOM_SPLIT",
            heldBy: actor.actorId,
            heldByLevel: actor.actorLevel,
            stage: Stage.S3,
          }).catch(() => null);
          if (held) heldDocuments.push({ id: held.id, kind: "PROFORMA", documentId: proforma.id });
        }
      }
      if (stage === Stage.S4 || stage === Stage.S5) {
        await step("RESERVE", async () => {
          const allKept = [...roomMap.keys()].every((f) => plan.modeOf(f) === "KEEP");
          const reserved = await confirmReservation(prisma, newId, actor.actorId, {
            version: await version(),
            holdGuestEmail: true,
            carryHighValueAuthority: allKept,
          });
          const held = await recordHeldDocument(prisma, {
            entryId: newId,
            kind: "CONFIRMATION_VOUCHER",
            documentId: reserved.reservation.id,
            reason: "ROOM_SPLIT",
            heldBy: actor.actorId,
            heldByLevel: actor.actorLevel,
            stage: Stage.S4,
          }).catch(() => null);
          if (held) heldDocuments.push({ id: held.id, kind: "CONFIRMATION_VOUCHER", documentId: reserved.reservation.id });
        });
      }
      if (stage === Stage.S5) {
        // The original was at Arrival, so the guest had answered its voucher; the split is their own
        // ask, and stands as the answer to this one. Arrival opens now only inside its window.
        await step("ARRIVAL", async () => {
          const voucher = await prisma.communicationRecord.findFirst({
            where: { entryId: newId, commType: "CONFIRMATION_VOUCHER", direction: "OUTBOUND", sendStatus: "DISPATCHED" },
            orderBy: { createdAt: "desc" },
          });
          if (voucher && voucher.acknowledgementStatus !== "RECEIVED") {
            await recordCommunicationAcknowledgement(prisma, voucher.id, actor, {
              method: "VERBAL",
              verbatimNote: `${movedWords} split off ${entry.id} to these dates at the guest's request: ${reason}.`,
            });
          }
          const windowDays = Number(await requireActiveConfigValue<number>(prisma, "preArrival.windowDays").catch(() => 1)) || 1;
          const opensAt = new Date(Date.parse(`${plan.newCheckIn}T00:00:00.000Z`) - windowDays * DAY);
          if (opensAt.getTime() > Date.now()) {
            createdNotes.push(`It waits at Reserve — Arrival opens on ${fmtDay(iso(opensAt))}`);
            return;
          }
          const engine = await getTimerEngine();
          const activation = await runPreArrivalWindowActivationWorker(prisma, engine, { entryId: newId }, { skipTaskReset: true });
          if (activation.skipped) throw new ValidationError(`Arrival did not open: ${activation.reason}`);
        });
      }
    }
  }

  // ── 4. Both bookings say what happened ───────────────────────────────────────────────────────
  const now = new Date();
  const payloadCommon = {
    fromEntryId: entry.id,
    toEntryId: newId,
    target,
    newInquiryId: target === "NEW_ENQUIRY" ? created.inquiryId : null,
    rooms: [...roomMap].map(([f, t]) => ({ fromRoomNumber: no(f), toRoomNumber: no(t) })),
    from: { checkInDate: iso(plan.priorIn), checkOutDate: iso(plan.priorOut) },
    to: { checkInDate: plan.newCheckIn, checkOutDate: plan.newCheckOut },
    guests: partyWords(plan.leaving),
    priceModes: Object.fromEntries([...roomMap.keys()].map((f) => [no(f), plan.modeOf(f)])),
    reason,
  };
  await prisma.traceEvent
    .createMany({
      data: [
        {
          eventType: "ENTRY.ROOMS_SPLIT_OFF",
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          entityType: "Entry",
          entityId: entry.id,
          operation: "UPDATE",
          timestamp: now,
          stageContext: stage,
          inquiryId: entry.inquiryId,
          entryId: entry.id,
          payload: payloadCommon as Prisma.InputJsonValue,
          createdBy: actor.actorId,
        },
        {
          eventType: "ENTRY.CREATED_FROM_SPLIT",
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          entityType: "Entry",
          entityId: newId,
          operation: "CREATE",
          timestamp: now,
          stageContext: Stage.S1,
          inquiryId: created.inquiryId,
          entryId: newId,
          payload: { ...payloadCommon, aimedAt, blocked } as Prisma.InputJsonValue,
          createdBy: actor.actorId,
        },
      ],
    })
    .catch(() => {});

  const after = await prisma.entry.findUniqueOrThrow({ where: { id: newId }, select: { currentStage: true } });
  return {
    target,
    source: { entryId: entry.id, route, walk, amendment },
    created: {
      entryId: newId,
      inquiryId: created.inquiryId,
      newInquiry: target === "NEW_ENQUIRY",
      reachedStage: String(after.currentStage),
      aimedAt,
      blocked,
      heldDocuments,
      quotationId,
      checkInDate: plan.newCheckIn,
      checkOutDate: plan.newCheckOut,
      notes: createdNotes,
    },
    createFailed: null,
  };
}
