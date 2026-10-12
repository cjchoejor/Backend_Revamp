import { Prisma, Stage, type PrismaClient } from "@prisma/client";
import { AppError, NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { findRoomBookingConflicts } from "../../lib/room-booking-conflicts.js";
import { applyRoomFlagRepairs, planRoomFlagRepairs } from "../../lib/room-flag-repair.js";
import { foldIsoNightsToRanges } from "../../lib/entry-inventory-claim.js";
import { resolveCompositionBasis } from "../../lib/party-seating.js";
import { effectiveCheckOutDate, hotelTodayUtc } from "../../lib/stay-dates.js";
import type { ToleratedClaim } from "../../lib/room-move-claims.js";
import { changeRoomToNewSegment, roomChangeNights, type RoomChangeOutcome, type RoomMoveWalkContext } from "./room-change-service.js";
import { buildQuotationPreview } from "./quotation-preview-service.js";
import type { RoomCompositionServiceInput } from "./s2-quotation-service.js";

/**
 * ROOM MOVES FROM THE HOUSE CHART (2026-10-12, operator request: "switch rooms between two
 * reservations — different stages, rooms and dates — through every procedure, every paper, with
 * the choice to send or not, and well audited").
 *
 * A move is a RECORD with one LEG per room that moves: one leg is a move into a free room, two legs
 * a swap; a drag of several selected rooms is several legs, and a booking sitting in a room one of
 * them lands on is given a leg back into the room that was left (operator rulings 2026-10-12: drag
 * and drop, Ctrl and Shift selection, keep their order, swap with what is there, one walk per
 * room). Each leg runs the governed room-change walk (`changeRoomToNewSegment`): a new pass, a
 * silent quotation, back through Set up, the hold re-placed, the booking re-confirmed with a new
 * voucher (or, at Set up, a fresh proforma), and back to the step it started on. Nothing is copied
 * or patched — every gate each booking would face on its own, it faces here.
 *
 * What the record adds is the part no single walk can do:
 *
 *   - **The claim.** While the move runs, each leg's target is claimed for its booking
 *     (lib/room-move-claims.ts), so no third booking can take either room mid-swap. A leg's own
 *     booking passes over its partner's claim on exactly the room the partner is leaving, and
 *     nothing else.
 *   - **Validation before anything changes.** Every leg is dry-run first (the walk's own checks,
 *     with nothing written), so a swap that one side cannot make is refused whole.
 *   - **Order and recovery.** Pre-arrival legs run first, in-house last, one walk after another.
 *     A leg refused before it starts walks every finished leg back to its own room while no in-house
 *     guest has moved yet (walk-backs are legs of the same move, so the rooms they return to stay
 *     claimed meanwhile), and leaves the move PARTIAL with Retry once one has — a guest who has
 *     physically moved is not moved back by a machine.
 *   - **Papers held.** Every walk holds the papers it makes (HeldDocument); the desk answers each:
 *     send by email, mark sent on WhatsApp, or don't send.
 *
 * Rulings (operator, 2026-10-12): a moved guest keeps the price they agreed unless the desk
 * re-prices them at the new room type with their agreement typed in; any two-booking switch needs
 * the FOM; two in-house guests may swap (FOM), and a refused second leg leaves the move PARTIAL.
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };
const RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
const atLeast = (lvl: string, need: string) => (RANK[lvl] ?? 0) >= (RANK[need] ?? 9);

export type RoomMoveLegInput = {
  entryId: string;
  fromRoomId: string;
  toRoomId: string;
  /** KEEP (default) = the guest keeps the agreed price; NEW_TYPE = re-priced at the new room type. */
  priceMode?: "KEEP" | "NEW_TYPE";
  /** Required when a cross-type leg is re-priced — the guest's agreement in the desk's words. */
  guestAgreedNote?: string | null;
  /** Set on a swap partner the preview added, when the desk sends the leg back — display only. */
  displacedBy?: string | null;
};

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
const IN_HOUSE = new Set<string>([Stage.S7]);
const MOVABLE = new Set<string>([Stage.S3, Stage.S4, Stage.S5, Stage.S6, Stage.S7]);
const ACTIVE_MOVE = ["IN_PROGRESS", "PARTIAL"] as const;

function errorParts(e: unknown): { message: string; code: string | null } {
  if (e instanceof AppError) return { message: e.body.message, code: e.body.blockingCondition ?? e.body.error ?? null };
  return { message: e instanceof Error ? e.message : String(e), code: null };
}

function guestName(g: { firstName: string | null; lastName: string | null } | null | undefined) {
  return [g?.firstName, g?.lastName].filter(Boolean).join(" ").trim() || null;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmtNight = (d: string) => {
  const dt = new Date(`${d}T00:00:00.000Z`);
  return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
};
/** "12 Oct – 14 Oct" per contiguous span (ends on the checkout morning), joined " · ". */
function nightsLabel(nights: string[]): string {
  return foldIsoNightsToRanges(nights)
    .map((r) => `${fmtNight(iso(r.startDate))} – ${fmtNight(iso(r.endDate))}`)
    .join(" · ");
}

async function loadLegBooking(prisma: PrismaClient, entryId: string) {
  return prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      status: true,
      currentStage: true,
      checkInDate: true,
      checkOutDate: true,
      actualCheckOutDate: true,
      inquiryId: true,
      noShowCutoffReachedAt: true,
      guestProfile: { select: { firstName: true, lastName: true } },
      reservation: { select: { frozenCheckInDate: true, frozenCheckOutDate: true } },
      stayExtensionRequests: { where: { state: { in: ["REQUESTED", "BILLED", "PAID"] } }, select: { id: true, state: true } },
      negotiationAmendmentRequests: { where: { state: "REQUESTED" }, select: { id: true } },
      roomMoveLegs: { where: { move: { status: { in: [...ACTIVE_MOVE] } } }, select: { moveId: true } },
    },
  });
}
type LegBooking = NonNullable<Awaited<ReturnType<typeof loadLegBooking>>>;

/** The refusals a booking meets before any walk is tried — each in the desk's words. */
function bookingRefusals(b: LegBooking, label: string, today: Date): string[] {
  const out: string[] = [];
  if (b.status === "PARKED") out.push(`${label} is parked — resume it first`);
  else if (b.status !== "ACTIVE") out.push(`${label} has ended — a sealed record is read-only`);
  const stage = String(b.currentStage);
  if (b.status === "ACTIVE" || b.status === "PARKED") {
    if (stage === Stage.S1 || stage === Stage.S2) {
      out.push(
        `${label} is still at ${STAGE_WORD[stage]} — its rooms are a provisional pick, not a booking yet; change them on its Negotiation step (Change configuration)`,
      );
    } else if (stage === Stage.S8) {
      out.push(`${label} is at Check-out — the guest is leaving, so the room is not moved now`);
    } else if (!MOVABLE.has(stage)) {
      out.push(`${label} is ${STAGE_WORD[stage] ?? stage} — nothing to move`);
    }
  }
  // An arrival that never happened (2026-10-12, found on the desk): a booking still waiting at Set
  // up, Reserve or Arrival whose check-in day has gone by holds nights nobody slept, and moving its
  // room would move those too. Its arrival cut-off has usually passed — the FOM decides the no-show
  // (or the desk moves its dates) first.
  const PRE_ARRIVAL = new Set<string>([Stage.S3, Stage.S4, Stage.S5]);
  const checkIn = b.reservation?.frozenCheckInDate ?? b.checkInDate ?? null;
  if ((b.status === "ACTIVE" || b.status === "PARKED") && PRE_ARRIVAL.has(stage) && checkIn && checkIn.getTime() < today.getTime()) {
    out.push(
      `${label} was due to arrive on ${fmtNight(iso(checkIn))} and has not checked in${b.noShowCutoffReachedAt ? " — its arrival cut-off has passed" : ""}. Decide the no-show, or move its dates, before moving its room`,
    );
  }
  if (stage === Stage.S7) {
    const out7 = effectiveCheckOutDate(b);
    if (out7 && out7.getTime() <= today.getTime()) {
      out.push(`${label} is past its check-out date and still in — check the guest out first`);
    }
  }
  if (b.stayExtensionRequests.length > 0) {
    out.push(`${label} has a stay extension waiting — commit or withdraw it first (it holds rooms by number)`);
  }
  if (b.negotiationAmendmentRequests.length > 0) {
    out.push(`${label} has a configuration change waiting for the FOM — decide it first`);
  }
  const otherMove = b.roomMoveLegs[0]?.moveId ?? null;
  if (otherMove) out.push(`${label} is already part of ${otherMove} — finish or resolve that move first`);
  return out;
}

/** What the walk will do for a booking at this step, in the desk's words. */
function pathFor(stage: string, sameType: boolean, priceMode: "KEEP" | "NEW_TYPE"): string[] {
  const price = sameType ? "re-quoted at the same price" : priceMode === "KEEP" ? "re-quoted, keeping the agreed price" : "re-priced at the new room type";
  const steps = ["a new pass opens (the old one is kept as history)", `back to Negotiation — ${price}`, "Set up — the rooms are held again"];
  if (stage === Stage.S3) return [...steps, "stops at Set up with a fresh proforma"];
  steps.push("re-confirmed at Reserve — a new voucher");
  if (stage === Stage.S4) return steps;
  if (stage === Stage.S5) return [...steps, "back to Arrival"];
  if (stage === Stage.S6) return [...steps, "back to Check-in"];
  return [...steps, "back to Stay — the guest moves tonight"];
}

/** How many bookings' rooms the desk may pick at once, and how many legs a move may grow to. */
const MAX_SELECTED = 8;
const MAX_LEGS = 12;

const legKey = (l: { entryId: string; fromRoomId: string }) => `${l.entryId}|${l.fromRoomId}`;

export type RoomMovePreviewLeg = {
  order: number;
  /** `entryId|fromRoomId` — a booking can move several of its rooms in one move. */
  key: string;
  entryId: string;
  fromRoomId: string;
  toRoomId: string;
  bookingLabel: string;
  guestName: string | null;
  stage: string;
  stageWord: string;
  fromRoom: { roomId: string; roomNumber: string; roomTypeName: string | null } | null;
  toRoom: { roomId: string; roomNumber: string; roomTypeName: string | null } | null;
  nights: string[];
  nightsLabel: string | null;
  sameType: boolean | null;
  priceMode: "KEEP" | "NEW_TYPE";
  guestAgreedNote: string | null;
  /** True when the leg was added because the booking sits in a room another leg moves into. */
  displaced: boolean;
  /** The booking whose leg made this one ("moves into the room ENT-… leaves"). */
  displacedBy: string | null;
  pricing: { before: number | null; after: number | null; delta: number | null; currency: string | null; note: string | null };
  path: string[];
  papers: string[];
  followUps: string[];
  refusals: string[];
};

export type RoomMovePreview = {
  kind: "MOVE" | "SWAP";
  ok: boolean;
  authority: { needed: "L1" | "L2"; actorLevel: string; ok: boolean; why: string };
  legs: RoomMovePreviewLeg[];
  /** Refusals that belong to the move as a whole, not to one booking. */
  refusals: string[];
};

type PlannedLeg = RoomMoveLegInput & { priceMode: "KEEP" | "NEW_TYPE"; displaced: boolean; displacedBy: string | null };

type DryLeg = {
  input: PlannedLeg;
  booking: LegBooking | null;
  label: string;
  dry: RoomChangeOutcome | null;
  refusals: string[];
};

async function bookingLabel(prisma: PrismaClient, b: LegBooking | null, entryId: string) {
  const name = guestName(b?.guestProfile ?? null);
  return name ? `${entryId} (${name})` : entryId;
}

type RoomRow = { id: string; roomNumber: string; roomTypeId: string; roomType: { name: string } | null };
async function loadRooms(prisma: PrismaClient, ids: string[]) {
  const rows: RoomRow[] = await prisma.room.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, roomNumber: true, roomTypeId: true, roomType: { select: { name: true } } },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * The shape of what was asked, before any booking is read: whole legs, no room twice, and no
 * booking moving into a room it is itself leaving in the same move (each room walks on its own,
 * one after another, so such a chain cannot be checked ahead — moved one at a time it can).
 */
function shapeRefusals(legs: RoomMoveLegInput[], rooms: Map<string, RoomRow>): string[] {
  const no = (id: string) => rooms.get(id)?.roomNumber ?? "?";
  const out: string[] = [];
  const seenFrom = new Map<string, string>();
  const seenTo = new Map<string, string>();
  const seenKey = new Set<string>();
  for (const l of legs) {
    if (l.fromRoomId === l.toRoomId) out.push(`${l.entryId} already has Room ${no(l.fromRoomId)}`);
    if (seenKey.has(legKey(l))) out.push(`${l.entryId}'s Room ${no(l.fromRoomId)} is picked twice`);
    seenKey.add(legKey(l));
    const fromOwner = seenFrom.get(l.fromRoomId);
    if (fromOwner && fromOwner !== l.entryId) {
      out.push(`Two bookings are moving out of Room ${no(l.fromRoomId)} — move them one at a time`);
    }
    seenFrom.set(l.fromRoomId, l.entryId);
    if (seenTo.has(l.toRoomId)) out.push(`Two of the picked rooms would land in Room ${no(l.toRoomId)} — drop them where each has its own room`);
    seenTo.set(l.toRoomId, l.entryId);
  }
  for (const l of legs) {
    const own = legs.find((o) => o !== l && o.entryId === l.entryId && o.fromRoomId === l.toRoomId);
    if (own) {
      out.push(
        `${l.entryId} would move into Room ${no(l.toRoomId)}, which it is leaving in the same move — drop the rooms where they do not overlap their own, or move them one at a time`,
      );
    }
  }
  return [...new Set(out)];
}

/**
 * Add the swap partners (operator ruling 2026-10-12: a booking dropped on a room another booking
 * holds swaps with it). For every leg, each OTHER booking holding the target room over the nights
 * the leg moves — and not itself leaving that room in this move — is given a leg back into the room
 * the chain started from: the leg's own room, or, when that room is itself taken by another leg of
 * the move, the room that leg left, and so on. One level only: a partner moves where a leg left,
 * and anything else in that room refuses the partner's own walk, in words.
 */
async function withSwapPartners(prisma: PrismaClient, asked: PlannedLeg[]): Promise<{ legs: PlannedLeg[]; truncated: boolean }> {
  const legs = [...asked];
  let truncated = false;
  const leavingRoom = (entryId: string, roomId: string) => legs.some((l) => l.entryId === entryId && l.fromRoomId === roomId);
  for (const leg of asked) {
    let nights: string[] = [];
    try {
      nights = await roomChangeNights(prisma, leg.entryId, leg.fromRoomId);
    } catch {
      continue; // the walk refuses this leg itself, in its own words
    }
    const holders = new Set<string>();
    for (const range of foldIsoNightsToRanges(nights)) {
      const conflicts = await findRoomBookingConflicts(prisma, {
        roomIds: [leg.toRoomId],
        checkIn: range.startDate,
        checkOut: range.endDate,
        excludeEntryId: leg.entryId,
        ignoreRoomMoves: true,
      });
      for (const c of conflicts) holders.add(c.entryId);
    }
    for (const holder of holders) {
      if (leavingRoom(holder, leg.toRoomId)) continue;
      // The room the chain started from.
      let back = leg.fromRoomId;
      const seen = new Set<string>([back]);
      for (;;) {
        const into = legs.find((l) => l.toRoomId === back && !(l.entryId === holder && l.fromRoomId === leg.toRoomId));
        if (!into || seen.has(into.fromRoomId)) break;
        back = into.fromRoomId;
        seen.add(back);
      }
      if (back === leg.toRoomId) continue;
      if (legs.length >= MAX_LEGS) {
        truncated = true;
        break;
      }
      legs.push({
        entryId: holder,
        fromRoomId: leg.toRoomId,
        toRoomId: back,
        priceMode: "KEEP",
        guestAgreedNote: null,
        displaced: true,
        displacedBy: leg.entryId,
      });
    }
  }
  return { legs, truncated };
}

/** Run every leg's walk as a dry run (nothing written), each passing over its partners' claims. */
async function dryRunLegs(prisma: PrismaClient, actor: Actor, legs: PlannedLeg[], reason: string): Promise<DryLeg[]> {
  const today = hotelTodayUtc();
  const out: DryLeg[] = [];
  for (const input of legs) {
    const booking = await loadLegBooking(prisma, input.entryId);
    const label = await bookingLabel(prisma, booking, input.entryId);
    const refusals: string[] = [];
    if (!booking) refusals.push(`${input.entryId} was not found`);
    else {
      // The "already part of another move" rule must not count this very move's own legs.
      refusals.push(...bookingRefusals(booking, label, today));
    }
    out.push({ input, booking, label, dry: null, refusals });
  }
  for (const leg of out) {
    if (leg.refusals.length > 0) continue;
    // Every other booking's leg leaving the room this one enters — the one claim passed over.
    const leaving = out.filter((p) => p.input.entryId !== leg.input.entryId && p.input.fromRoomId === leg.input.toRoomId);
    const tolerate: ToleratedClaim[] = leaving.map((p) => ({ entryId: p.input.entryId, roomId: leg.input.toRoomId }));
    const partner = leaving[0] ?? out.find((p) => p.input.entryId !== leg.input.entryId) ?? null;
    const moveContext: RoomMoveWalkContext = {
      moveId: null,
      legId: null,
      partnerEntryId: partner?.input.entryId ?? null,
      partnerLabel: partner?.label ?? null,
      tolerate,
      priceMode: leg.input.priceMode,
      guestAgreedNote: leg.input.guestAgreedNote?.trim() || null,
    };
    try {
      // The preview reports the authority a move needs rather than refusing on it, so the dry run
      // is asked at FOM level at least; the real run uses the operator's own level.
      const level = atLeast(actor.actorLevel, "L2") ? actor.actorLevel : "L2";
      leg.dry = await changeRoomToNewSegment(prisma, { actorId: actor.actorId, actorLevel: level }, {
        entryId: leg.input.entryId,
        fromRoomId: leg.input.fromRoomId,
        toRoomId: leg.input.toRoomId,
        reason: reason || "Room move preview",
        dryRun: true,
        moveContext,
      });
      if (leg.input.priceMode === "NEW_TYPE" && !leg.dry.sameType && !leg.input.guestAgreedNote?.trim()) {
        leg.refusals.push(`${leg.label} is re-priced at the new room type — type what the guest agreed to`);
      }
    } catch (e) {
      leg.refusals.push(...(await refusalWords(prisma, leg.label, e, today)));
    }
  }
  return out;
}

/**
 * A refusal in the desk's words. A room another booking holds names the booking, its nights and —
 * when those nights are already past and the booking never arrived — what frees the room: the
 * chart starts at today, so a clash on a night before it is otherwise invisible.
 */
async function refusalWords(prisma: PrismaClient, label: string, e: unknown, today: Date): Promise<string[]> {
  const parts = errorParts(e);
  const details = e instanceof AppError ? (e.body.details as { conflicts?: unknown } | undefined) : undefined;
  const conflicts = Array.isArray(details?.conflicts)
    ? (details!.conflicts as Array<{ entryId: string | null; roomNumber: string | null; guestName: string | null; startDate: string; endDate: string }>)
    : null;
  if (!conflicts || conflicts.length === 0) return [`${label}: ${parts.message}`];
  const ids = [...new Set(conflicts.map((c) => c.entryId).filter((x): x is string => !!x))];
  const holders = await prisma.entry.findMany({
    where: { id: { in: ids } },
    select: { id: true, currentStage: true, noShowCutoffReachedAt: true, checkInDate: true },
  });
  const byId = new Map(holders.map((h) => [h.id, h]));
  const todayIso = iso(today);
  return conflicts.map((c) => {
    const who = [c.entryId, c.guestName].filter(Boolean).join(" · ") || "another booking";
    const span = nightsLabel(nightsBetweenIso(c.startDate, c.endDate));
    const past = c.endDate <= todayIso;
    const h = c.entryId ? byId.get(c.entryId) : undefined;
    const stale = h && [Stage.S3, Stage.S4, Stage.S5].includes(h.currentStage as never) && h.checkInDate && iso(h.checkInDate) < todayIso;
    const room = c.roomNumber ? `Room ${c.roomNumber}` : "The room";
    if (past && stale) {
      return `${label}: ${room} is held ${span} by ${who} — nights already past, which the chart does not show. That booking never arrived${h!.noShowCutoffReachedAt ? " and its arrival cut-off has passed" : ""}: decide its no-show to free the room`;
    }
    if (past) return `${label}: ${room} is held ${span} by ${who} — nights already past, which the chart does not show`;
    return `${label}: ${room} is taken ${span} by ${who}`;
  });
}

function nightsBetweenIso(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${start}T00:00:00.000Z`); iso(d) < end; d = new Date(d.getTime() + 86_400_000)) out.push(iso(d));
  return out;
}

async function priceLeg(prisma: PrismaClient, leg: DryLeg, roomsOfBooking: number): Promise<RoomMovePreviewLeg["pricing"]> {
  const dry = leg.dry;
  const before = dry?.pricing.priorTotal ?? null;
  const currency = dry?.pricing.currency ?? null;
  const plan = dry?.plan ?? null;
  // Several rooms of one booking walk one after another, each priced on its own walk.
  const oneAtATime = roomsOfBooking > 1 ? "This booking's rooms move one at a time — the figure is for this room's move alone" : null;
  if (!dry || !plan) return { before, after: null, delta: null, currency, note: null };
  if (!plan.compositions || plan.compositions.length === 0) {
    return { before, after: null, delta: null, currency, note: "Priced the way the booking is priced today (a flat rate) — the new quotation states the figure" };
  }
  try {
    const preview = await buildQuotationPreview(
      prisma,
      leg.input.entryId,
      {
        roomCompositions: plan.compositions as never,
        discount: plan.discount ? { percent: plan.discount.discountPercent ?? null, amount: plan.discount.discountAmount ?? null } : null,
      },
      {
        planRoomIds: plan.planRoomIds,
        stayOverride: {
          checkIn: new Date(plan.checkIn),
          checkOut: new Date(plan.checkOut),
          perRoomNightCounts: new Map(Object.entries(plan.perRoomNightCounts)),
        },
      },
    );
    const after = preview.payable;
    const kept = !dry.sameType && leg.input.priceMode === "KEEP" ? "The guest keeps the room rate they agreed" : null;
    return {
      before,
      after,
      delta: before != null ? Number((after - before).toFixed(2)) : null,
      currency: preview.currency ?? currency,
      note: [kept, oneAtATime].filter(Boolean).join(" · ") || null,
    };
  } catch (e) {
    return { before, after: null, delta: null, currency, note: `Could not price it ahead: ${errorParts(e).message}` };
  }
}

function followUpsFor(leg: DryLeg, all: DryLeg[]): string[] {
  const out: string[] = [];
  const stage = String(leg.booking?.currentStage ?? "");
  const from = leg.dry?.fromRoom.roomNumber ?? "?";
  const to = leg.dry?.toRoom.roomNumber ?? "?";
  const others = all.filter((p) => p.input.entryId !== leg.input.entryId);
  if (stage === Stage.S7) {
    out.push(`Take back the key to Room ${from}, then hand over Room ${to}'s from the Stay step's Keys`);
    // Another in-house guest moving straight into this room keeps it occupied; otherwise it is turned.
    const enteredByInHouse = others.some((p) => String(p.booking?.currentStage ?? "") === Stage.S7 && p.input.toRoomId === leg.input.fromRoomId);
    if (!enteredByInHouse) out.push(`Room ${from} is marked departed — housekeeping turns it`);
  }
  // The room this booking enters is being left by an in-house guest: it is turned first.
  const enteringVacatedRoom =
    stage !== Stage.S7 && others.some((p) => String(p.booking?.currentStage ?? "") === Stage.S7 && p.input.fromRoomId === leg.input.toRoomId);
  if (stage === Stage.S6) {
    out.push(
      enteringVacatedRoom
        ? `Check-in waits until Room ${to} is turned — its guest moves out tonight`
        : `Check-in waits until Room ${to} is ready`,
    );
  } else if (enteringVacatedRoom) {
    const first = leg.dry?.toRooms[0]?.nights[0] ?? null;
    out.push(`Room ${to} must be turned before ${leg.label} arrives${first ? ` on ${fmtNight(first)}` : ""}`);
  }
  return out;
}

export async function previewRoomMove(
  prisma: PrismaClient,
  actor: Actor,
  input: { legs: RoomMoveLegInput[]; reason?: string | null },
): Promise<RoomMovePreview> {
  if (!Array.isArray(input.legs) || input.legs.length === 0) throw new ValidationError("Pick the booking (and room) to move");
  for (const l of input.legs) {
    if (!l.entryId?.trim() || !l.fromRoomId?.trim() || !l.toRoomId?.trim()) throw new ValidationError("Each booking needs its room and the room it moves to");
  }
  const asked: PlannedLeg[] = input.legs.map((l) => ({
    entryId: l.entryId,
    fromRoomId: l.fromRoomId,
    toRoomId: l.toRoomId,
    priceMode: l.priceMode === "NEW_TYPE" ? "NEW_TYPE" : "KEEP",
    guestAgreedNote: l.guestAgreedNote?.trim() || null,
    displaced: !!l.displacedBy,
    displacedBy: l.displacedBy ?? null,
  }));
  const selectedCount = new Set(asked.map(legKey)).size;
  if (selectedCount > MAX_SELECTED) throw new ValidationError(`Pick at most ${MAX_SELECTED} rooms at a time`);

  const reason = input.reason?.trim() ?? "";
  // The swap partners — added once, by the server, whatever the desk sent (a call that already
  // names a partner leg leaves it as it is).
  const { legs: planned, truncated } = await withSwapPartners(prisma, asked);
  // A leg the desk sent that the server would add anyway is the same leg: keep the desk's choices.
  const rooms = await loadRooms(prisma, planned.flatMap((l) => [l.fromRoomId, l.toRoomId]));
  const shape = shapeRefusals(planned, rooms);
  const legs = await dryRunLegs(prisma, actor, planned, reason);

  const roomView = (id: string) => {
    const r = rooms.get(id);
    return r ? { roomId: r.id, roomNumber: r.roomNumber, roomTypeName: r.roomType?.name ?? null } : null;
  };
  const sameTypeOf = (l: DryLeg) =>
    l.dry?.sameType ??
    (rooms.get(l.input.fromRoomId) && rooms.get(l.input.toRoomId)
      ? rooms.get(l.input.fromRoomId)!.roomTypeId === rooms.get(l.input.toRoomId)!.roomTypeId
      : null);
  const bookings = new Set(planned.map((l) => l.entryId));
  const kind: "MOVE" | "SWAP" = bookings.size > 1 ? "SWAP" : "MOVE";
  const sameTypeAll = legs.every((l) => sameTypeOf(l) !== false);
  const needed: "L1" | "L2" = kind === "SWAP" || !sameTypeAll ? "L2" : "L1";
  const authority = {
    needed,
    actorLevel: actor.actorLevel,
    ok: atLeast(actor.actorLevel, needed),
    why:
      kind === "SWAP"
        ? "Moving more than one booking moves a guest who did not ask — it needs the FOM"
        : needed === "L2"
          ? "A different room type is an upgrade or downgrade — it needs the FOM"
          : "A move into a free room of the same type is desk work",
  };
  const out: RoomMovePreviewLeg[] = [];
  for (const [i, leg] of legs.entries()) {
    const stage = String(leg.booking?.currentStage ?? "");
    const nights = leg.dry?.toRooms.find((r) => r.roomId === leg.input.toRoomId)?.nights ?? leg.dry?.substitutionNights ?? [];
    const roomsOfBooking = planned.filter((p) => p.entryId === leg.input.entryId).length;
    out.push({
      order: i + 1,
      key: legKey(leg.input),
      entryId: leg.input.entryId,
      fromRoomId: leg.input.fromRoomId,
      toRoomId: leg.input.toRoomId,
      bookingLabel: leg.label,
      guestName: guestName(leg.booking?.guestProfile ?? null),
      stage,
      stageWord: STAGE_WORD[stage] ?? stage,
      fromRoom: leg.dry?.fromRoom ?? roomView(leg.input.fromRoomId),
      toRoom: leg.dry?.toRoom ?? roomView(leg.input.toRoomId),
      nights,
      nightsLabel: nights.length ? nightsLabel(nights) : null,
      sameType: sameTypeOf(leg),
      priceMode: leg.input.priceMode,
      guestAgreedNote: leg.input.guestAgreedNote ?? null,
      displaced: leg.input.displaced,
      displacedBy: leg.input.displacedBy,
      pricing: await priceLeg(prisma, leg, roomsOfBooking),
      path: leg.dry ? pathFor(stage, leg.dry.sameType, leg.input.priceMode) : [],
      papers: leg.dry
        ? stage === Stage.S3
          ? ["A new quotation (kept on file, not sent)", "A fresh proforma — held for you to send or not"]
          : ["A new quotation (kept on file, not sent)", "A new confirmation voucher — held for you to send or not"]
        : [],
      followUps: leg.dry ? followUpsFor(leg, legs) : [],
      refusals: leg.refusals,
    });
  }
  const refusals = truncated ? [...shape, `A move can grow to at most ${MAX_LEGS} rooms with the bookings it swaps with — pick fewer`] : shape;
  return { kind, ok: authority.ok && refusals.length === 0 && out.every((l) => l.refusals.length === 0), authority, legs: out, refusals };
}

/* ─────────────────────────────── the record ─────────────────────────────── */

type MoveRow = Prisma.RoomMoveGetPayload<{
  include: {
    legs: {
      include: {
        entry: { select: { id: true; currentStage: true; guestProfile: { select: { firstName: true; lastName: true } } } };
        fromRoom: { select: { roomNumber: true } };
        toRoom: { select: { roomNumber: true } };
        heldDocuments: true;
      };
    };
  };
}>;

const moveInclude = {
  legs: {
    orderBy: { order: "asc" as const },
    include: {
      entry: { select: { id: true, currentStage: true, guestProfile: { select: { firstName: true, lastName: true } } } },
      fromRoom: { select: { roomNumber: true } },
      toRoom: { select: { roomNumber: true } },
      heldDocuments: { orderBy: { heldAt: "desc" as const } },
    },
  },
};

export type RoomMoveView = ReturnType<typeof viewMove>;

type LegOutcome = Partial<RoomChangeOutcome> & { refusal?: { message: string; code: string | null }; compensates?: string };

function viewMove(m: MoveRow) {
  return {
    id: m.id,
    kind: m.kind,
    status: m.status,
    reason: m.reason,
    requestedBy: m.requestedBy,
    requestedLevel: m.requestedLevel,
    createdAt: m.createdAt.toISOString(),
    completedAt: m.completedAt?.toISOString() ?? null,
    notes: (m.notes ?? []) as unknown[],
    legs: m.legs.map((l) => {
      const o = (l.outcome ?? null) as LegOutcome | null;
      const nights = Array.isArray(l.nights) ? (l.nights as string[]) : [];
      return {
        id: l.id,
        order: l.order,
        entryId: l.entryId,
        guestName: guestName(l.entry.guestProfile),
        currentStage: String(l.entry.currentStage),
        fromRoomId: l.fromRoomId,
        fromRoomNumber: l.fromRoom.roomNumber,
        toRoomId: l.toRoomId,
        toRoomNumber: l.toRoom.roomNumber,
        nights,
        nightsLabel: nights.length ? nightsLabel(nights) : null,
        originStage: String(l.originStage),
        priceMode: l.priceMode,
        guestAgreedNote: l.guestAgreedNote,
        status: l.status,
        compensates: o?.compensates ?? null,
        refusal: o?.refusal ?? null,
        newSegmentNumber: o?.newSegmentNumber ?? null,
        reachedStage: o?.walk?.reachedStage ?? null,
        blocked: o?.walk?.blocked ?? null,
        pricing: o?.pricing ?? null,
        quotationId: o?.quotationId ?? null,
        startedAt: l.startedAt?.toISOString() ?? null,
        finishedAt: l.finishedAt?.toISOString() ?? null,
        heldDocuments: l.heldDocuments.map((h) => ({
          id: h.id,
          kind: h.kind,
          documentId: h.documentId,
          decision: h.decision,
          sentTo: h.sentTo,
          decidedAt: h.decidedAt?.toISOString() ?? null,
        })),
      };
    }),
  };
}

export async function getRoomMove(prisma: PrismaClient, moveId: string) {
  const m = await prisma.roomMove.findUnique({ where: { id: moveId }, include: moveInclude });
  if (!m) throw new NotFoundError("Room move");
  return viewMove(m);
}

export async function listRoomMovesForEntry(prisma: PrismaClient, entryId: string) {
  const rows = await prisma.roomMove.findMany({
    where: { legs: { some: { entryId } } },
    include: moveInclude,
    orderBy: { createdAt: "desc" },
  });
  return rows.map(viewMove);
}

async function trace(
  prisma: PrismaClient | Prisma.TransactionClient,
  actor: Actor,
  eventType: string,
  entryId: string,
  stage: string | null,
  payload: Record<string, unknown>,
) {
  await prisma.traceEvent
    .create({
      data: {
        eventType,
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "RoomMove",
        entityId: String(payload.moveId ?? ""),
        operation: "UPDATE",
        timestamp: new Date(),
        ...(stage && stage in Stage ? { stageContext: stage as Stage } : {}),
        entryId,
        payload: payload as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    })
    .catch(() => {});
}

async function appendNote(prisma: PrismaClient, moveId: string, note: Record<string, unknown>) {
  const m = await prisma.roomMove.findUniqueOrThrow({ where: { id: moveId }, select: { notes: true } });
  const notes = Array.isArray(m.notes) ? (m.notes as unknown[]) : [];
  await prisma.roomMove.update({
    where: { id: moveId },
    data: { notes: [...notes, { at: new Date().toISOString(), ...note }] as Prisma.InputJsonValue },
  });
}

/** One leg's governed walk, recorded on the leg: DONE · STOPPED (part-way) · REFUSED (before it started). */
async function runLeg(
  prisma: PrismaClient,
  actor: Actor,
  moveId: string,
  legId: string,
  reason: string,
  opts: { roomCompositions?: RoomCompositionServiceInput[] | null; compensates?: string | null } = {},
): Promise<"DONE" | "STOPPED" | "REFUSED"> {
  const leg = await prisma.roomMoveLeg.findUniqueOrThrow({ where: { id: legId } });
  const others = await prisma.roomMoveLeg.findMany({
    where: { moveId, id: { not: legId }, entryId: { not: leg.entryId } },
    include: { entry: { select: { guestProfile: { select: { firstName: true, lastName: true } } } } },
  });
  // The partner named on this leg's papers: the booking leaving the room it enters, else any other.
  const partner = others.find((p) => p.fromRoomId === leg.toRoomId) ?? others[0] ?? null;
  const partnerLabel = partner
    ? guestName(partner.entry.guestProfile)
      ? `${partner.entryId} (${guestName(partner.entry.guestProfile)})`
      : partner.entryId
    : null;
  const segmentsBefore = await prisma.segment.count({ where: { entryId: leg.entryId } });
  await prisma.roomMoveLeg.update({ where: { id: legId }, data: { startedAt: new Date() } });
  // Both guests in-house and another one already moved into this leg's room: it is not left empty.
  const fromRoomEnteredByPartner =
    String(leg.originStage) === Stage.S7 &&
    others.some((p) => p.status === "DONE" && String(p.originStage) === Stage.S7 && p.toRoomId === leg.fromRoomId);
  let status: "DONE" | "STOPPED" | "REFUSED";
  let outcome: Record<string, unknown>;
  try {
    const out = await changeRoomToNewSegment(prisma, actor, {
      entryId: leg.entryId,
      fromRoomId: leg.fromRoomId,
      toRoomId: leg.toRoomId,
      reason,
      ...(opts.roomCompositions?.length ? { roomCompositions: opts.roomCompositions } : {}),
      moveContext: {
        moveId,
        legId,
        partnerEntryId: partner?.entryId ?? null,
        partnerLabel,
        tolerate: [],
        priceMode: leg.priceMode,
        guestAgreedNote: leg.guestAgreedNote,
        fromRoomEnteredByPartner,
      },
    });
    status = out.walk.blocked ? "STOPPED" : "DONE";
    outcome = { ...(out as unknown as Record<string, unknown>), ...(opts.compensates ? { compensates: opts.compensates } : {}) };
  } catch (e) {
    const refusal = errorParts(e);
    const segmentsAfter = await prisma.segment.count({ where: { entryId: leg.entryId } });
    // Past the re-entry the booking has already changed — a throw there is a stop, not a refusal.
    status = segmentsAfter > segmentsBefore ? "STOPPED" : "REFUSED";
    outcome = {
      refusal,
      ...(status === "STOPPED" ? { walk: { returnedToOrigin: false, reachedStage: null, blocked: { atStep: "unknown", ...refusal } } } : {}),
      ...(opts.compensates ? { compensates: opts.compensates } : {}),
    };
  }
  await prisma.roomMoveLeg.update({
    where: { id: legId },
    data: { status, outcome: outcome as Prisma.InputJsonValue, finishedAt: new Date() },
  });
  const blocked = (outcome.walk as { blocked?: { message?: string } | null } | undefined)?.blocked ?? null;
  await trace(
    prisma,
    actor,
    status === "DONE" ? "ROOM_MOVE.LEG_COMPLETED" : status === "STOPPED" ? "ROOM_MOVE.LEG_BLOCKED" : "ROOM_MOVE.LEG_REFUSED",
    leg.entryId,
    String(leg.originStage),
    {
      moveId,
      legId,
      fromRoomId: leg.fromRoomId,
      toRoomId: leg.toRoomId,
      partnerEntryId: partner?.entryId ?? null,
      compensates: opts.compensates ?? null,
      reachedStage: (outcome.walk as { reachedStage?: string } | undefined)?.reachedStage ?? null,
      why: status === "REFUSED" ? (outcome.refusal as { message: string }).message : blocked?.message ?? null,
    },
  );
  return status;
}

/** The compositions a booking is priced on now — what a walk back restores. */
async function currentCompositions(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      segments: { orderBy: { segmentNumber: "desc" }, select: { id: true } },
      quotations: { select: { id: true, segmentId: true, state: true, versionNumber: true, createdAt: true, commercialTerms: true } },
      reservation: { select: { frozenCommercialTerms: true } },
      reservations: { select: { confirmedAt: true, frozenCommercialTerms: true } },
    },
  });
  if (!entry) return null;
  return resolveCompositionBasis<RoomCompositionServiceInput>(entry).compositions ?? null;
}

/** Room flags of the rooms the move touched, re-derived from the bookings that now hold them. */
async function repairMoveRooms(prisma: PrismaClient, roomIds: string[]) {
  try {
    const { plan, today } = await planRoomFlagRepairs(prisma, { roomIds: [...new Set(roomIds)] });
    return await applyRoomFlagRepairs(prisma, plan, today);
  } catch {
    return 0;
  }
}

const compensatesOf = (l: { outcome: Prisma.JsonValue | null }) => ((l.outcome ?? null) as LegOutcome | null)?.compensates ?? null;

async function settleMoveStatus(prisma: PrismaClient, actor: Actor, moveId: string) {
  const m = await prisma.roomMove.findUniqueOrThrow({ where: { id: moveId }, include: { legs: true } });
  const originals = m.legs.filter((l) => !compensatesOf(l));
  const walkBacks = m.legs.filter((l) => !!compensatesOf(l));
  let status: "COMPLETED" | "PARTIAL" | "REVERTED" | "FAILED";
  if (originals.some((l) => l.status === "REVERTED")) {
    // Walked back: every original leg is undone or never ran, and every walk-back finished.
    const settled = originals.every((l) => ["REVERTED", "REFUSED", "CANCELLED"].includes(l.status)) && walkBacks.every((l) => l.status === "DONE");
    status = settled ? "REVERTED" : "PARTIAL";
  } else if (originals.every((l) => l.status === "DONE")) status = "COMPLETED";
  else if (originals.every((l) => l.status === "REFUSED" || l.status === "CANCELLED")) status = "FAILED";
  else status = "PARTIAL";
  const done = status !== "PARTIAL";
  await prisma.roomMove.update({ where: { id: moveId }, data: { status, completedAt: done ? new Date() : null } });
  for (const entryId of [...new Set(m.legs.map((l) => l.entryId))]) {
    await trace(prisma, actor, `ROOM_MOVE.${status}`, entryId, null, {
      moveId,
      legs: m.legs.map((l) => ({ legId: l.id, entryId: l.entryId, fromRoomId: l.fromRoomId, toRoomId: l.toRoomId, status: l.status })),
    });
  }
  await repairMoveRooms(prisma, m.legs.flatMap((l) => [l.fromRoomId, l.toRoomId]));
  return status;
}

/**
 * Walk back every finished leg of a move that has not reached an in-house guest — newest first, as
 * legs of the same move, all created before any runs so each keeps the room it returns to claimed.
 * A booking moving several rooms is restored to the very terms it had (its original compositions)
 * on its last walk-back; the earlier ones carry the price, as every move does.
 */
async function walkBack(
  prisma: PrismaClient,
  actor: Actor,
  moveId: string,
  done: Array<{ id: string; entryId: string; fromRoomId: string; toRoomId: string; nights: Prisma.JsonValue; originStage: Stage; priceMode: "KEEP" | "NEW_TYPE" }>,
  originalComps: Map<string, RoomCompositionServiceInput[] | null>,
  because: string,
) {
  const reversed = [...done].reverse();
  const top = await prisma.roomMoveLeg.aggregate({ where: { moveId }, _max: { order: true } });
  let order = top._max.order ?? 0;
  const backs: Array<{ id: string; of: string; entryId: string }> = [];
  for (const l of reversed) {
    const b = await prisma.roomMoveLeg.create({
      data: {
        moveId,
        order: ++order,
        entryId: l.entryId,
        fromRoomId: l.toRoomId,
        toRoomId: l.fromRoomId,
        nights: l.nights as Prisma.InputJsonValue,
        originStage: l.originStage,
        priceMode: l.priceMode,
      },
    });
    backs.push({ id: b.id, of: l.id, entryId: l.entryId });
  }
  let allBack = true;
  for (const [i, b] of backs.entries()) {
    const lastForBooking = !backs.slice(i + 1).some((x) => x.entryId === b.entryId);
    const st = await runLeg(prisma, actor, moveId, b.id, `Undoing ${moveId}: ${because}`, {
      roomCompositions: lastForBooking ? originalComps.get(b.entryId) ?? null : null,
      compensates: b.of,
    });
    if (st === "DONE") {
      await prisma.roomMoveLeg.update({ where: { id: b.of }, data: { status: "REVERTED" } });
      const orig = done.find((d) => d.id === b.of)!;
      await trace(prisma, actor, "ROOM_MOVE.WALKED_BACK", orig.entryId, String(orig.originStage), { moveId, legId: b.of, undoLegId: b.id, because });
    } else {
      allBack = false;
      // A walk-back that cannot run leaves the rest where they are: the move is part-done.
      await appendNote(prisma, moveId, { kind: "WALK_BACK_FAILED", by: actor.actorId, legId: b.id });
      break;
    }
  }
  return allBack;
}

export async function executeRoomMove(
  prisma: PrismaClient,
  actor: Actor,
  input: { legs: RoomMoveLegInput[]; reason: string },
) {
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("Say why the room is being moved");
  const preview = await previewRoomMove(prisma, actor, { legs: input.legs, reason });
  if (!preview.authority.ok) {
    throw new PolicyGateBlockedError("AUTH_REQUIRED_L2", `${preview.authority.why} — you are signed in as ${actor.actorLevel}`);
  }
  const refusals = [...preview.refusals, ...preview.legs.flatMap((l) => l.refusals)];
  if (refusals.length > 0) throw new PolicyGateBlockedError("ROOM_MOVE_REFUSED", refusals.join(" · "), { refusals });

  // Pre-arrival legs first, in-house last: an in-house guest physically moves, and is the one a
  // machine never moves back — so they move only once every other side is safely done.
  const ordered = [...preview.legs].sort((a, b) => Number(IN_HOUSE.has(a.stage)) - Number(IN_HOUSE.has(b.stage)) || a.order - b.order);

  const now = new Date();
  const moveId = await prisma.$transaction(async (tx) => {
    // One move at a time is created; once it exists, its claims and the "already part of a move"
    // refusal protect its bookings and rooms.
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(730226101)::text AS locked`);
    const entryIds = ordered.map((l) => l.entryId);
    const roomIds = ordered.flatMap((l) => [l.fromRoomId, l.toRoomId]);
    const clash = await tx.roomMoveLeg.findFirst({
      where: {
        move: { status: { in: [...ACTIVE_MOVE] } },
        OR: [{ entryId: { in: entryIds } }, { fromRoomId: { in: roomIds } }, { toRoomId: { in: roomIds } }],
      },
      select: { moveId: true },
    });
    if (clash) throw new PolicyGateBlockedError("ROOM_MOVE_BUSY", `${clash.moveId} is already moving one of these bookings or rooms — finish or resolve it first`);
    const id = await allocateReadableId(tx, "ROOM_MOVE", now);
    await tx.roomMove.create({
      data: {
        id,
        kind: preview.kind,
        reason,
        requestedBy: actor.actorId,
        requestedLevel: actor.actorLevel,
        legs: {
          create: ordered.map((l, i) => ({
            order: i + 1,
            entryId: l.entryId,
            fromRoomId: l.fromRoomId,
            toRoomId: l.toRoomId,
            nights: l.nights as Prisma.InputJsonValue,
            originStage: l.stage as Stage,
            priceMode: l.priceMode,
            guestAgreedNote: l.guestAgreedNote,
          })),
        },
      },
    });
    return id;
  });
  const legs = await prisma.roomMoveLeg.findMany({ where: { moveId }, orderBy: { order: "asc" } });
  for (const l of legs) {
    const partner = legs.find((p) => p.entryId !== l.entryId && p.fromRoomId === l.toRoomId) ?? legs.find((p) => p.entryId !== l.entryId) ?? null;
    await trace(prisma, actor, "ROOM_MOVE.STARTED", l.entryId, String(l.originStage), {
      moveId,
      legId: l.id,
      kind: preview.kind,
      fromRoomId: l.fromRoomId,
      toRoomId: l.toRoomId,
      partnerEntryId: partner?.entryId ?? null,
      legs: legs.length,
      reason,
    });
  }

  // What each booking is priced on before any of it moves — what a walk back restores.
  const originalComps = new Map<string, RoomCompositionServiceInput[] | null>();
  for (const entryId of [...new Set(legs.map((l) => l.entryId))]) originalComps.set(entryId, await currentCompositions(prisma, entryId));

  const done: typeof legs = [];
  for (const [i, leg] of legs.entries()) {
    const st = await runLeg(prisma, actor, moveId, leg.id, reason);
    if (st === "DONE") {
      done.push(leg);
      continue;
    }
    if (st === "STOPPED") {
      // A walk that stopped part-way leaves its booking between passes. Nothing more runs — not its
      // other rooms, not the bookings swapping with it — and nothing is walked back over it: the
      // desk finishes that booking from its page, then retries the rest or closes the move.
      break;
    }
    // REFUSED before it started.
    const rest = legs.slice(i + 1);
    const inHouseMoved = done.some((d) => IN_HOUSE.has(String(d.originStage)));
    if (!inHouseMoved && done.length > 0) {
      // Nobody in-house has moved yet: put every finished leg back. The refused leg and the legs that
      // never ran stop claiming while the walk-backs run, then the refused one keeps its record.
      for (const r of rest) await prisma.roomMoveLeg.update({ where: { id: r.id }, data: { status: "CANCELLED" } });
      await prisma.roomMoveLeg.update({ where: { id: leg.id }, data: { status: "CANCELLED" } });
      const why = ((await prisma.roomMoveLeg.findUniqueOrThrow({ where: { id: leg.id } })).outcome as LegOutcome | null)?.refusal?.message;
      await walkBack(prisma, actor, moveId, done, originalComps, `${leg.entryId} could not move${why ? ` — ${why}` : ""}`);
      await prisma.roomMoveLeg.update({ where: { id: leg.id }, data: { status: "REFUSED" } });
    } else if (done.length === 0) {
      for (const r of rest) await prisma.roomMoveLeg.update({ where: { id: r.id }, data: { status: "CANCELLED" } });
    }
    // An in-house guest has moved: no machine moves them back. The rest wait for Retry.
    break;
  }
  await settleMoveStatus(prisma, actor, moveId);
  return getRoomMove(prisma, moveId);
}

/** Run a leg of a part-done move that was refused or never ran — FOM. */
export async function retryRoomMoveLeg(prisma: PrismaClient, actor: Actor, moveId: string, legId: string, reason?: string | null) {
  if (!atLeast(actor.actorLevel, "L2")) throw new PolicyGateBlockedError("AUTH_REQUIRED_L2", "Retrying a room move needs the FOM");
  const m = await prisma.roomMove.findUnique({ where: { id: moveId }, include: { legs: true } });
  if (!m) throw new NotFoundError("Room move");
  if (m.status !== "PARTIAL") throw new ValidationError(`${moveId} is ${m.status.toLowerCase().replace("_", " ")} — only a part-done move is retried`);
  const leg = m.legs.find((l) => l.id === legId);
  if (!leg) throw new NotFoundError("Room move leg");
  if (leg.status !== "REFUSED" && leg.status !== "PLANNED") {
    throw new ValidationError(
      leg.status === "STOPPED"
        ? "This booking's walk already began and stopped part-way — finish it from the booking's own page, then close the move"
        : "Only a booking whose move was refused, or has not run yet, is run again",
    );
  }
  const stopped = m.legs.find((l) => l.entryId === leg.entryId && l.status === "STOPPED");
  if (stopped) {
    throw new ValidationError(`${leg.entryId} has a walk that stopped part-way in this move — finish it from the booking's page first`);
  }
  await trace(prisma, actor, "ROOM_MOVE.LEG_RETRIED", leg.entryId, String(leg.originStage), { moveId, legId });
  await prisma.roomMoveLeg.update({ where: { id: legId }, data: { status: "PLANNED", outcome: Prisma.JsonNull, startedAt: null, finishedAt: null } });
  await runLeg(prisma, actor, moveId, legId, reason?.trim() || m.reason);
  await settleMoveStatus(prisma, actor, moveId);
  return getRoomMove(prisma, moveId);
}

/**
 * Close a PARTIAL move — FOM. Allowed only once no double booking is left between the move's
 * bookings on its rooms, judged from real bookings alone: the move's claim is what keeps the rooms
 * safe, so it lets go only when nothing needs it.
 */
export async function resolveRoomMove(prisma: PrismaClient, actor: Actor, moveId: string, note: string) {
  if (!atLeast(actor.actorLevel, "L2")) throw new PolicyGateBlockedError("AUTH_REQUIRED_L2", "Closing a part-done room move needs the FOM");
  const text = note?.trim();
  if (!text) throw new ValidationError("Say how it was settled");
  const m = await prisma.roomMove.findUnique({ where: { id: moveId }, include: { legs: { include: { toRoom: { select: { roomNumber: true } } } } } });
  if (!m) throw new NotFoundError("Room move");
  if (m.status !== "PARTIAL") throw new ValidationError(`${moveId} is not part-done — nothing to resolve`);
  const clashes: string[] = [];
  for (const l of m.legs) {
    if (l.status === "CANCELLED" || l.status === "REVERTED") continue;
    const nights = Array.isArray(l.nights) ? (l.nights as string[]) : [];
    for (const range of foldIsoNightsToRanges(nights)) {
      const conflicts = await findRoomBookingConflicts(prisma, {
        roomIds: [l.toRoomId],
        checkIn: range.startDate,
        checkOut: range.endDate,
        excludeEntryId: l.entryId,
        ignoreRoomMoves: true,
      });
      // Only the booking's own claim on the room counts as settled: a clash with another booking of
      // this move means one of them still holds the room it was meant to leave.
      const ours = conflicts.filter((c) => m.legs.some((o) => o.entryId === c.entryId));
      if (ours.length > 0) {
        clashes.push(`Room ${l.toRoom.roomNumber} is still held by ${[...new Set(ours.map((c) => c.entryId))].join(", ")} as well as ${l.entryId}`);
      }
    }
  }
  if (clashes.length > 0) {
    throw new PolicyGateBlockedError(
      "ROOM_MOVE_STILL_CLASHES",
      `${[...new Set(clashes)].join(" · ")} — move one of them on its own page first, then close the move`,
    );
  }
  await appendNote(prisma, moveId, { kind: "RESOLVED", by: actor.actorId, level: actor.actorLevel, note: text });
  await prisma.roomMove.update({ where: { id: moveId }, data: { status: "COMPLETED", completedAt: new Date() } });
  for (const entryId of [...new Set(m.legs.map((l) => l.entryId))]) {
    await trace(prisma, actor, "ROOM_MOVE.RESOLVED", entryId, null, { moveId, note: text });
  }
  await repairMoveRooms(prisma, m.legs.flatMap((l) => [l.fromRoomId, l.toRoomId]));
  return getRoomMove(prisma, moveId);
}
