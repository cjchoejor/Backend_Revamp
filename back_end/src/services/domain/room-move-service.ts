import { Prisma, Stage, type PrismaClient } from "@prisma/client";
import { AppError, NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { findRoomBookingConflicts } from "../../lib/room-booking-conflicts.js";
import { applyRoomFlagRepairs, planRoomFlagRepairs } from "../../lib/room-flag-repair.js";
import { foldIsoNightsToRanges } from "../../lib/entry-inventory-claim.js";
import { resolveCompositionBasis } from "../../lib/party-seating.js";
import { effectiveCheckOutDate, hotelTodayUtc } from "../../lib/stay-dates.js";
import type { ToleratedClaim } from "../../lib/room-move-claims.js";
import { changeRoomToNewSegment, type RoomChangeOutcome, type RoomMoveWalkContext } from "./room-change-service.js";
import { buildQuotationPreview } from "./quotation-preview-service.js";
import type { RoomCompositionServiceInput } from "./s2-quotation-service.js";

/**
 * ROOM MOVES FROM THE HOUSE CHART (2026-10-12, operator request: "switch rooms between two
 * reservations — different stages, rooms and dates — through every procedure, every paper, with
 * the choice to send or not, and well audited").
 *
 * A move is a RECORD with one LEG per booking: one leg is a move into a free room, two legs are a
 * swap. Each leg runs the governed room-change walk (`changeRoomToNewSegment`): a new pass, a
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
 *   - **Order and recovery.** Pre-arrival legs run first, in-house last. A second leg refused
 *     before it starts walks the first back to its own room when the first was pre-arrival (a
 *     third leg of the same move, so the room it returns to stays claimed meanwhile), and leaves
 *     the move PARTIAL with Retry when the first was in-house — a guest who has physically moved is
 *     not moved back by a machine.
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

export type RoomMovePreviewLeg = {
  order: number;
  entryId: string;
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

type DryLeg = {
  input: RoomMoveLegInput & { priceMode: "KEEP" | "NEW_TYPE" };
  booking: LegBooking | null;
  label: string;
  dry: RoomChangeOutcome | null;
  refusals: string[];
};

async function bookingLabel(prisma: PrismaClient, b: LegBooking | null, entryId: string) {
  const name = guestName(b?.guestProfile ?? null);
  return name ? `${entryId} (${name})` : entryId;
}

/** Shape check of the legs asked for — before any booking is read. */
function checkLegShape(legs: RoomMoveLegInput[]) {
  if (!Array.isArray(legs) || legs.length === 0) throw new ValidationError("Name the booking (and room) to move");
  if (legs.length > 2) throw new ValidationError("A move takes one booking, or two to swap — a rotation of three is not built yet");
  for (const l of legs) {
    if (!l.entryId?.trim() || !l.fromRoomId?.trim() || !l.toRoomId?.trim()) throw new ValidationError("Each booking needs its room and the room it moves to");
    if (l.fromRoomId === l.toRoomId) throw new ValidationError("That is the room the booking already has");
  }
  if (legs.length === 2) {
    const [a, b] = legs;
    if (a.entryId === b.entryId) throw new ValidationError("Both bars are the same booking — pick two different bookings to switch");
    if (a.toRoomId !== b.fromRoomId || b.toRoomId !== a.fromRoomId) {
      throw new ValidationError("A switch exchanges the two bookings' rooms — each must move into the room the other leaves");
    }
  }
}

/** Run every leg's walk as a dry run (nothing written), each tolerating its partner. */
async function dryRunLegs(prisma: PrismaClient, actor: Actor, legs: RoomMoveLegInput[], reason: string): Promise<DryLeg[]> {
  const today = hotelTodayUtc();
  const out: DryLeg[] = [];
  for (const raw of legs) {
    const priceMode = raw.priceMode === "NEW_TYPE" ? "NEW_TYPE" : "KEEP";
    const input = { ...raw, priceMode } as DryLeg["input"];
    const booking = await loadLegBooking(prisma, raw.entryId);
    const label = await bookingLabel(prisma, booking, raw.entryId);
    const refusals: string[] = [];
    if (!booking) refusals.push(`${raw.entryId} was not found`);
    else refusals.push(...bookingRefusals(booking, label, today));
    out.push({ input, booking, label, dry: null, refusals });
  }
  for (const leg of out) {
    if (leg.refusals.length > 0) continue;
    const partner = out.find((p) => p !== leg) ?? null;
    const tolerate: ToleratedClaim[] =
      partner && partner.input.fromRoomId === leg.input.toRoomId ? [{ entryId: partner.input.entryId, roomId: leg.input.toRoomId }] : [];
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

async function priceLeg(prisma: PrismaClient, leg: DryLeg): Promise<RoomMovePreviewLeg["pricing"]> {
  const dry = leg.dry;
  const before = dry?.pricing.priorTotal ?? null;
  const currency = dry?.pricing.currency ?? null;
  const plan = dry?.plan ?? null;
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
    return {
      before,
      after,
      delta: before != null ? Number((after - before).toFixed(2)) : null,
      currency: preview.currency ?? currency,
      note: !dry.sameType && leg.input.priceMode === "KEEP" ? "The guest keeps the room rate they agreed" : null,
    };
  } catch (e) {
    return { before, after: null, delta: null, currency, note: `Could not price it ahead: ${errorParts(e).message}` };
  }
}

function followUpsFor(leg: DryLeg, partner: DryLeg | null): string[] {
  const out: string[] = [];
  const stage = String(leg.booking?.currentStage ?? "");
  const from = leg.dry?.fromRoom.roomNumber ?? "?";
  const to = leg.dry?.toRoom.roomNumber ?? "?";
  if (stage === Stage.S7) {
    out.push(`Take back the key to Room ${from}, then hand over Room ${to}'s from the Stay step's Keys`);
    const partnerInHouse = String(partner?.booking?.currentStage ?? "") === Stage.S7;
    if (!partnerInHouse) out.push(`Room ${from} is marked departed — housekeeping turns it`);
  }
  // The room this booking enters is being left by an in-house guest: it is turned first.
  const enteringVacatedRoom =
    !!partner && String(partner.booking?.currentStage ?? "") === Stage.S7 && stage !== Stage.S7 && partner.input.fromRoomId === leg.input.toRoomId;
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
  checkLegShape(input.legs);
  const reason = input.reason?.trim() ?? "";
  const legs = await dryRunLegs(prisma, actor, input.legs, reason);
  const kind = input.legs.length === 2 ? "SWAP" : "MOVE";
  // The rooms themselves, read apart from the walk: a refused walk returns nothing, and the dialog
  // must still name both rooms and say whether the type changes (an upgrade needs the FOM whether
  // or not something else refuses it).
  const roomRows = await prisma.room.findMany({
    where: { id: { in: [...new Set(input.legs.flatMap((l) => [l.fromRoomId, l.toRoomId]))] } },
    select: { id: true, roomNumber: true, roomTypeId: true, roomType: { select: { name: true } } },
  });
  const roomById = new Map(roomRows.map((r) => [r.id, r]));
  const roomView = (id: string) => {
    const r = roomById.get(id);
    return r ? { roomId: r.id, roomNumber: r.roomNumber, roomTypeName: r.roomType?.name ?? null } : null;
  };
  const sameTypeOf = (l: DryLeg) =>
    l.dry?.sameType ??
    (roomById.get(l.input.fromRoomId) && roomById.get(l.input.toRoomId)
      ? roomById.get(l.input.fromRoomId)!.roomTypeId === roomById.get(l.input.toRoomId)!.roomTypeId
      : null);
  const sameTypeAll = legs.every((l) => sameTypeOf(l) !== false);
  const needed: "L1" | "L2" = kind === "SWAP" || !sameTypeAll ? "L2" : "L1";
  const authority = {
    needed,
    actorLevel: actor.actorLevel,
    ok: atLeast(actor.actorLevel, needed),
    why:
      kind === "SWAP"
        ? "Switching two bookings moves a guest who did not ask — it needs the FOM"
        : needed === "L2"
          ? "A different room type is an upgrade or downgrade — it needs the FOM"
          : "A move into a free room of the same type is desk work",
  };
  const out: RoomMovePreviewLeg[] = [];
  for (const [i, leg] of legs.entries()) {
    const partner = legs.find((p) => p !== leg) ?? null;
    const stage = String(leg.booking?.currentStage ?? "");
    const nights = leg.dry?.toRooms.find((r) => r.roomId === leg.input.toRoomId)?.nights ?? leg.dry?.substitutionNights ?? [];
    out.push({
      order: i + 1,
      entryId: leg.input.entryId,
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
      pricing: await priceLeg(prisma, leg),
      path: leg.dry ? pathFor(stage, leg.dry.sameType, leg.input.priceMode) : [],
      papers: leg.dry
        ? stage === Stage.S3
          ? ["A new quotation (kept on file, not sent)", "A fresh proforma — held for you to send or not"]
          : ["A new quotation (kept on file, not sent)", "A new confirmation voucher — held for you to send or not"]
        : [],
      followUps: leg.dry ? followUpsFor(leg, partner) : [],
      refusals: leg.refusals,
    });
  }
  const refusals: string[] = [];
  return { kind, ok: authority.ok && out.every((l) => l.refusals.length === 0), authority, legs: out, refusals };
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
      const o = (l.outcome ?? null) as (Partial<RoomChangeOutcome> & { refusal?: { message: string; code: string | null }; compensates?: string }) | null;
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
  const partners = await prisma.roomMoveLeg.findMany({
    where: { moveId, id: { not: legId }, entryId: { not: leg.entryId } },
    include: { entry: { select: { guestProfile: { select: { firstName: true, lastName: true } } } } },
  });
  const partner = partners[0] ?? null;
  const partnerLabel = partner
    ? guestName(partner.entry.guestProfile)
      ? `${partner.entryId} (${guestName(partner.entry.guestProfile)})`
      : partner.entryId
    : null;
  const segmentsBefore = await prisma.segment.count({ where: { entryId: leg.entryId } });
  await prisma.roomMoveLeg.update({ where: { id: legId }, data: { startedAt: new Date() } });
  // Both guests in-house and the partner already moved into this leg's room: it is not left empty.
  const fromRoomEnteredByPartner =
    String(leg.originStage) === Stage.S7 &&
    partners.some((p) => p.status === "DONE" && String(p.originStage) === Stage.S7 && p.toRoomId === leg.fromRoomId);
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

async function settleMoveStatus(prisma: PrismaClient, actor: Actor, moveId: string) {
  const m = await prisma.roomMove.findUniqueOrThrow({ where: { id: moveId }, include: { legs: true } });
  const live = m.legs.filter((l) => l.status !== "CANCELLED");
  let status: "COMPLETED" | "PARTIAL" | "REVERTED" | "FAILED";
  if (m.legs.some((l) => l.status === "REVERTED") && live.every((l) => l.status === "DONE" || l.status === "REVERTED" || l.status === "REFUSED")) {
    // Walked back: the compensating leg is DONE and every original leg is REVERTED or REFUSED.
    status = live.some((l) => l.status === "DONE" && !((l.outcome ?? {}) as { compensates?: string }).compensates) ? "PARTIAL" : "REVERTED";
  } else if (live.every((l) => l.status === "DONE")) status = "COMPLETED";
  else if (live.every((l) => l.status === "REFUSED")) status = "FAILED";
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
  const refusals = preview.legs.flatMap((l) => l.refusals);
  if (refusals.length > 0) throw new PolicyGateBlockedError("ROOM_MOVE_REFUSED", refusals.join(" · "), { refusals });

  // Pre-arrival legs first, in-house last: an in-house guest physically moves, and is the one a
  // machine never moves back — so they move only once the other side is safely done.
  const ordered = preview.legs
    .map((l, i) => ({ l, raw: input.legs[i] }))
    .sort((a, b) => Number(IN_HOUSE.has(a.l.stage)) - Number(IN_HOUSE.has(b.l.stage)) || a.l.order - b.l.order);

  const now = new Date();
  const moveId = await prisma.$transaction(async (tx) => {
    // One move at a time is created; once it exists, its claims and the "already part of a move"
    // refusal protect its bookings and rooms.
    await tx.$queryRawUnsafe(`SELECT pg_advisory_xact_lock(730226101)::text AS locked`);
    const entryIds = input.legs.map((l) => l.entryId);
    const roomIds = input.legs.flatMap((l) => [l.fromRoomId, l.toRoomId]);
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
          create: ordered.map(({ l, raw }, i) => ({
            order: i + 1,
            entryId: l.entryId,
            fromRoomId: raw.fromRoomId,
            toRoomId: raw.toRoomId,
            nights: l.nights as Prisma.InputJsonValue,
            originStage: l.stage as Stage,
            priceMode: l.priceMode,
            guestAgreedNote: raw.guestAgreedNote?.trim() || null,
          })),
        },
      },
    });
    return id;
  });
  const legs = await prisma.roomMoveLeg.findMany({ where: { moveId }, orderBy: { order: "asc" } });
  for (const l of legs) {
    const partner = legs.find((p) => p.id !== l.id) ?? null;
    await trace(prisma, actor, "ROOM_MOVE.STARTED", l.entryId, String(l.originStage), {
      moveId,
      legId: l.id,
      kind: preview.kind,
      fromRoomId: l.fromRoomId,
      toRoomId: l.toRoomId,
      partnerEntryId: partner?.entryId ?? null,
      reason,
    });
  }

  // What the first booking is priced on, before it moves — what a walk back restores.
  const firstCompositions = legs.length === 2 ? await currentCompositions(prisma, legs[0].entryId) : null;

  const first = await runLeg(prisma, actor, moveId, legs[0].id, reason);
  if (legs.length === 1 || first === "REFUSED") {
    if (legs.length === 2 && first === "REFUSED") {
      await prisma.roomMoveLeg.update({ where: { id: legs[1].id }, data: { status: "CANCELLED" } });
    }
    await settleMoveStatus(prisma, actor, moveId);
    return getRoomMove(prisma, moveId);
  }

  const second = await runLeg(prisma, actor, moveId, legs[1].id, reason);
  if (second === "REFUSED" && first === "DONE" && !IN_HOUSE.has(String(legs[0].originStage))) {
    // The second booking cannot move and the first is not in-house: walk the first back to its own
    // room, as a third leg of the same move — its claim keeps that room safe while it walks.
    const back = await prisma.roomMoveLeg.create({
      data: {
        moveId,
        order: 3,
        entryId: legs[0].entryId,
        fromRoomId: legs[0].toRoomId,
        toRoomId: legs[0].fromRoomId,
        nights: legs[0].nights as Prisma.InputJsonValue,
        originStage: legs[0].originStage,
        priceMode: legs[0].priceMode,
      },
    });
    await prisma.roomMoveLeg.update({ where: { id: legs[1].id }, data: { status: "CANCELLED" } });
    const why = ((await prisma.roomMoveLeg.findUniqueOrThrow({ where: { id: legs[1].id } })).outcome as { refusal?: { message: string } } | null)
      ?.refusal?.message;
    const undo = await runLeg(prisma, actor, moveId, back.id, `Undoing ${moveId}: ${legs[1].entryId} could not move${why ? ` — ${why}` : ""}`, {
      roomCompositions: firstCompositions,
      compensates: legs[0].id,
    });
    if (undo === "DONE") {
      await prisma.roomMoveLeg.update({ where: { id: legs[0].id }, data: { status: "REVERTED" } });
      // The refused leg is the reason for the walk-back — kept on the record as refused.
      await prisma.roomMoveLeg.update({ where: { id: legs[1].id }, data: { status: "REFUSED" } });
      await trace(prisma, actor, "ROOM_MOVE.WALKED_BACK", legs[0].entryId, String(legs[0].originStage), {
        moveId,
        legId: legs[0].id,
        undoLegId: back.id,
        because: why ?? null,
      });
    } else {
      await prisma.roomMoveLeg.update({ where: { id: legs[1].id }, data: { status: "REFUSED" } });
      await appendNote(prisma, moveId, { kind: "WALK_BACK_FAILED", by: actor.actorId, legId: back.id });
    }
  }
  await settleMoveStatus(prisma, actor, moveId);
  return getRoomMove(prisma, moveId);
}

/** Run again a leg that never started (REFUSED) on a PARTIAL move — FOM. */
export async function retryRoomMoveLeg(prisma: PrismaClient, actor: Actor, moveId: string, legId: string, reason?: string | null) {
  if (!atLeast(actor.actorLevel, "L2")) throw new PolicyGateBlockedError("AUTH_REQUIRED_L2", "Retrying a room move needs the FOM");
  const m = await prisma.roomMove.findUnique({ where: { id: moveId }, include: { legs: true } });
  if (!m) throw new NotFoundError("Room move");
  if (m.status !== "PARTIAL") throw new ValidationError(`${moveId} is ${m.status.toLowerCase().replace("_", " ")} — only a part-done move is retried`);
  const leg = m.legs.find((l) => l.id === legId);
  if (!leg) throw new NotFoundError("Room move leg");
  if (leg.status !== "REFUSED") {
    throw new ValidationError(
      leg.status === "STOPPED"
        ? "This booking's walk already began and stopped part-way — finish it from the booking's own page, then resolve the move"
        : "Only a booking whose move was refused before it started is retried",
    );
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
