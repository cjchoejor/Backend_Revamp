import type { PrismaClient } from "@prisma/client";
import { EntryStatus, FolioLineType, FolioState, InventoryClaimState, NightAuditRunStatus, Prisma, Stage } from "@prisma/client";
import { isBookingNightPosted } from "../application/s7-night-audit-service.js";
import { AppError, NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { requireActiveMode } from "../../lib/mode-registry-runtime.js";
import { transitionRoomClaimState } from "../../lib/room-claim-state.js";
import { loadEntryDetail } from "../../lib/entry-detail-include.js";
import { round2, toDecimal } from "../../lib/money.js";
import { frozenCompositionByRoom, splitFrozenRow } from "../../lib/frozen-room-composition.js";
import { periodWords, rentPeriods } from "../../lib/apartment-rent.js";
import { lineTax } from "../../lib/stay-posting.js";
import { NIGHT_AUDIT_ROOM_CHARGE_DESCRIPTION_PREFIX } from "../../lib/folio-tax-lines.js";
import { effectiveCheckInDate, hotelTodayUtc, listNightYmdsUtc, nightsBetweenUtc, utcDateOnly, ymdUtc } from "../../lib/stay-dates.js";
import { resolveChargeRates } from "../infrastructure/compute-stay-charges.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { correctCharge, postCharge } from "./s7-folio-lines-service.js";
import { resolveBillingModelForNewLine } from "../../lib/billing-model-defaults.js";
import { progressStageS7ToS8 } from "../../state-machines/entry-lifecycle-state-machine.js";
import {
  enforceEarlyDepartureAuthority,
  enforceEarlyDepartureDateWithinStay,
  enforceEarlyDepartureInHouse,
  enforceSleptNightsAuditedForEarlyDeparture,
} from "../../policies/14-cancellation/p36-early-departure.js";

/**
 * Early departure — a guest leaving before the booked checkout (2026-08-22; SIG-S8 §1.2 "Early
 * departure" entry route, Policy 36, EARLY_DEPARTURE mode).
 *
 * What the spec asks for, and what this does:
 *
 *  - GM authority (Policy 36, hardcoded) — `enforceEarlyDepartureAuthority`, level from the session.
 *  - "Night audit complete for all nights already stayed" — every slept night must carry a COMPLETE
 *    NightAuditRecord before the stay is shortened (`enforceSleptNightsAuditedForEarlyDeparture`).
 *  - "Shortened stay charges are calculated against the original commitment snapshot — the rate is
 *    not retrospectively renegotiated": nothing is re-quoted. The slept nights stay on the ledger
 *    exactly as the audits posted them from the frozen rows; each RoomAssignment row is END-DATED
 *    at the departure with its frozen figures scaled to the nights it now covers (the same row
 *    surgery an in-house room change performs), so settlement's rate-basis expectation (p22,
 *    Σ frozenSubtotal) and the night-audit window both read the shortened stay on their own.
 *  - "Charges for unstayed nights governed by the early departure policy": the unstayed nights are
 *    simply never posted, and the configurable fee (`earlyDeparture.penalty`, per rate plan) is
 *    posted on the live folio as one SERVICE charge (SC/GST companions follow) — or waived by the GM.
 *  - "Early Departure mode compresses S7→S8": once recorded, the stay's effective checkout IS
 *    today, so the standard S7→S8 gate passes (its Policy 36 date gate, the same-day H4 auto-fulfil
 *    and the final-night audit all key on the effective checkout) and this service attempts the
 *    move itself. The Check-out step then runs unchanged: settlement over the slept nights, keys,
 *    inspection, invoice, S9.
 *
 * The Reservation row is immutable, so the real end of the stay is denormalised on
 * `Entry.actualCheckOutDate` (+ `Entry.checkOutDate`, which the Today list reads) and every date
 * reader goes through `effectiveCheckOutDate()`; the inventory claim ends there too, so the
 * unstayed nights are free for the S1 search the moment the departure is recorded.
 *
 * PARTIAL-OUTCOME CONTRACT (mirrors the room-change composite): the record + row surgery commit in
 * one transaction and are the irreversible part. The fee posting and the S7→S8 move run after it,
 * each best-effort and reported honestly (`feePosted`, `movedToCheckout` / `checkoutBlocked`) —
 * a blocked move leaves the booking at S7 with the stay already shortened, and the operator
 * finishes through the normal "Continue to Check-out".
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };

export type EarlyDeparturePenaltyBasis = "NONE" | "FLAT_AMOUNT" | "UNSTAYED_NIGHTS" | "PERCENT_OF_UNSTAYED";

export type EarlyDeparturePenaltyRule = {
  basis: EarlyDeparturePenaltyBasis;
  /** FLAT_AMOUNT: the net fee. */
  amount: number;
  /** UNSTAYED_NIGHTS: how many unstayed nights (at most) are charged. */
  nights: number;
  /** UNSTAYED_NIGHTS / PERCENT_OF_UNSTAYED: share of the frozen room figure, 0–100. */
  percent: number;
  /** Which rate plan's override was applied, if any. */
  ratePlanId: string | null;
  ratePlanOverride: boolean;
};

export interface EarlyDepartureRoomFigure {
  assignmentId: string;
  roomId: string;
  roomNumber: string | null;
  startDate: string;
  /** The row's end BEFORE the shortening (exclusive). */
  endDate: string;
  totalNights: number;
  sleptNights: number;
  unstayedNights: number;
  /** NET per-night room figure the audit posts for this row (frozenSubtotal ÷ nights, or the legacy frozenRate). */
  perNightSubtotal: number;
  /**
   * The ROOM part of that figure — room and extra bed, the row's meal plan taken out (2026-09-18).
   * The fee is priced on this: a guest who leaves early is not charged for dinners never served.
   */
  perNightRoomSubtotal: number;
  /** NET room charges the unstayed nights would have posted. */
  forgoneSubtotal: number;
  /** Tax-inclusive counterpart. */
  forgoneTotal: number;
  /**
   * An apartment's rent periods already posted that the stay cut short no longer owes in full
   * (2026-11-25): each put right to the rent of the nights stayed, by the rent rule.
   */
  rentCorrections: Array<{ periodFrom: string; periodTo: string; postedNet: number; owedNet: number; owedWords: string | null }>;
  /** The row's frozen figures after the shortening (null on legacy flat rows, which carry none). */
  newFrozenSubtotal: number | null;
  newFrozenTotal: number | null;
  legacyFlatRate: boolean;
  /** True when the row is actually touched by the shortening (it ran past the departure). */
  shortened: boolean;
  /**
   * This room's own early-departure fee, by the same rule (2026-11-26): what is posted on the room
   * when some rooms leave and the rest stay. NET; null on a room not shortened.
   */
  feeAmount: number | null;
}

export interface EarlyDepartureFigures {
  entryId: string;
  /**
   * BOOKING — every room the stay still uses leaves (the stay ends early); ROOMS — only the rooms
   * named leave and the rest stay on (2026-11-26).
   */
  scope: "BOOKING" | "ROOMS";
  /** The rooms named, when some rooms leave. */
  roomIds: string[];
  /** The rooms the stay still uses after the departure date — what the desk picks from. */
  roomsInUse: Array<{ roomId: string; roomNumber: string | null; roomTypeName: string | null; endDate: string; nightsLeft: number; apartment: boolean }>;
  /** The departure is a later day: the stay (or the rooms) are shortened now and leave then. */
  later: boolean;
  hotelToday: string;
  checkIn: string | null;
  bookedCheckOut: string | null;
  departureDate: string;
  bookedNights: number;
  sleptNights: number;
  unstayedNights: number;
  rooms: EarlyDepartureRoomFigure[];
  forgoneRoomSubtotal: number;
  forgoneRoomTotal: number;
  fee: {
    rule: EarlyDeparturePenaltyRule;
    /** NET fee the rule yields (before any waiver). */
    amount: number;
    /** Indicative gross (fee + SC + GST at today's rates) — the ledger's companion lines are the truth. */
    gross: number;
    serviceChargeRate: number;
    gstRate: number;
    description: string;
    explanation: string;
  };
  /** Every night already stayed and whether its hotel-wide audit is COMPLETE. */
  sleptNightAudits: Array<{ date: string; status: string }>;
  missingNightYmds: string[];
  /** Why the departure cannot be recorded right now (empty = recordable by a GM). */
  blockers: Array<{ code: string; message: string }>;
  requiredLevel: "L3";
  openStayExtensionRequestId: string | null;
  alreadyRecorded: { id: string; departureDate: string; recordedAt: string } | null;
}

const DEFAULT_RULE = { basis: "NONE" as EarlyDeparturePenaltyBasis, amount: 0, nights: 1, percent: 100 };
const BASES: readonly EarlyDeparturePenaltyBasis[] = ["NONE", "FLAT_AMOUNT", "UNSTAYED_NIGHTS", "PERCENT_OF_UNSTAYED"];

function num(v: unknown, fallback: number): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function money(d: Prisma.Decimal): number {
  return Number(round2(d).toFixed(2));
}

/** Resolve the fee rule: the base config with the reservation's rate-plan override merged over it. */
export function resolveEarlyDeparturePenaltyRule(cfg: unknown, ratePlanId: string | null): EarlyDeparturePenaltyRule {
  const base = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, unknown>;
  const perPlan = (base.perRatePlan && typeof base.perRatePlan === "object" ? base.perRatePlan : {}) as Record<string, unknown>;
  const candidate = ratePlanId ? perPlan[ratePlanId] : null;
  const override = candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : null;
  const pick = (k: keyof typeof DEFAULT_RULE): unknown => (override && override[k] != null ? override[k] : base[k]);
  const basisRaw = String(pick("basis") ?? DEFAULT_RULE.basis).toUpperCase() as EarlyDeparturePenaltyBasis;
  return {
    basis: BASES.includes(basisRaw) ? basisRaw : "NONE",
    amount: Math.max(0, num(pick("amount"), DEFAULT_RULE.amount)),
    nights: Math.max(0, Math.floor(num(pick("nights"), DEFAULT_RULE.nights))),
    percent: Math.min(100, Math.max(0, num(pick("percent"), DEFAULT_RULE.percent))),
    ratePlanId,
    ratePlanOverride: !!override,
  };
}

const ENTRY_INCLUDE = {
  reservation: true,
  folio: { select: { id: true, state: true, outstandingBalance: true } },
  roomAssignments: {
    include: { room: { select: { id: true, roomNumber: true, currentClaimState: true, roomType: { select: { name: true } } } } },
    orderBy: { createdAt: "asc" as const },
  },
  segments: { orderBy: { segmentNumber: "desc" as const }, take: 1, select: { id: true } },
  stayExtensionRequests: { where: { state: { in: ["REQUESTED", "BILLED", "PAID"] } }, select: { id: true, state: true } },
  earlyDeparture: { select: { id: true, departureDate: true, recordedAt: true } },
  roomDepartures: { where: { state: "SCHEDULED" }, select: { id: true, roomId: true, roomNumber: true, departureDate: true } },
} satisfies Prisma.EntryInclude;

type LoadedEntry = Prisma.EntryGetPayload<{ include: typeof ENTRY_INCLUDE }>;

async function loadEntry(prisma: PrismaClient, entryId: string): Promise<LoadedEntry> {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: ENTRY_INCLUDE });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

function nightsWord(n: number): string {
  return `${n} night${n === 1 ? "" : "s"}`;
}

function describeNights(ymds: string[]): string {
  if (ymds.length === 0) return "";
  const fmt = (ymd: string) =>
    new Date(`${ymd}T00:00:00.000Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return ymds.length === 1 ? fmt(ymds[0]) : `${fmt(ymds[0])} – ${fmt(ymds[ymds.length - 1])}`;
}

/**
 * The figures of an early departure, computed and nothing written. `departureDate` defaults to
 * the hotel's today. Blockers are REPORTED (not thrown) so the desk can show why the button is
 * locked; `recordEarlyDeparture` runs the same checks as gates.
 */
export async function computeEarlyDepartureFigures(
  prisma: PrismaClient,
  entryId: string,
  input: { departureDate?: string | null; roomIds?: string[] | null },
): Promise<EarlyDepartureFigures> {
  const entry = await loadEntry(prisma, entryId);
  const hotelToday = hotelTodayUtc();
  const checkIn = effectiveCheckInDate(entry);
  const bookedCheckOut = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate ?? null;
  const parsedDeparture = input.departureDate ? new Date(input.departureDate) : null;
  if (parsedDeparture && Number.isNaN(parsedDeparture.getTime())) throw new ValidationError("departureDate must be a valid ISO date");
  const departure = parsedDeparture ? utcDateOnly(parsedDeparture) : hotelToday;
  const later = departure.getTime() > hotelToday.getTime();

  const blockers: Array<{ code: string; message: string }> = [];
  const push = (code: string, message: string) => blockers.push({ code, message });

  // Which rooms the stay still uses after the departure date, and whether the rooms named are all
  // of them (the stay ends early) or some (the rest stay on) — 2026-11-26.
  const rentRooms = new Set(
    [...frozenCompositionByRoom([entry.reservation?.frozenCommercialTerms ?? null]).entries()].filter(([, c]) => !!c?.rent).map(([id]) => id),
  );
  const inUse = new Map<string, { roomId: string; roomNumber: string | null; roomTypeName: string | null; end: Date }>();
  for (const a of entry.roomAssignments) {
    const rs = a.startDate ?? checkIn;
    const re = a.endDate ?? bookedCheckOut;
    if (!rs || !re || re.getTime() <= rs.getTime() || re.getTime() <= departure.getTime()) continue;
    const had = inUse.get(a.roomId);
    if (!had || re.getTime() > had.end.getTime()) {
      inUse.set(a.roomId, { roomId: a.roomId, roomNumber: a.room?.roomNumber ?? null, roomTypeName: a.room?.roomType?.name ?? null, end: re });
    }
  }
  const named = Array.from(new Set((input.roomIds ?? []).map((x) => x.trim()).filter(Boolean)));
  const scope: "BOOKING" | "ROOMS" = named.length > 0 && [...inUse.keys()].some((id) => !named.includes(id)) ? "ROOMS" : "BOOKING";
  const chosen = new Set(scope === "ROOMS" ? named : [...inUse.keys()]);
  if (scope === "ROOMS") {
    const byId = new Map(entry.roomAssignments.map((a) => [a.roomId, a.room] as const));
    for (const id of named) {
      const room = byId.get(id);
      const no = room?.roomNumber ?? id.slice(0, 6);
      if (!room) push("ROOM_NOT_ON_BOOKING", "That room is not one of this booking's rooms");
      else if (!inUse.has(id)) push("ROOM_NOT_IN_USE", `Room ${no} is not in use after ${describeNights([ymdUtc(departure)])} — nothing to shorten`);
      else if (room.currentClaimState !== InventoryClaimState.OCCUPIED)
        push("ROOM_NOT_OCCUPIED", `Room ${no} is not occupied by the guest now — a room leaves from a stay in it`);
      if (rentRooms.has(id)) push("APARTMENT_ROOM", `Room ${no} is let as an apartment — an apartment leaves early as the whole booking`);
      const scheduled = entry.roomDepartures.find((d) => d.roomId === id);
      if (scheduled) push("ROOM_ALREADY_LEAVING", `Room ${no} is already recorded to leave on ${describeNights([ymdUtc(scheduled.departureDate)])} (${scheduled.id})`);
    }
  }

  if (entry.status !== EntryStatus.ACTIVE) push("ENTRY_NOT_ACTIVE", `The booking is ${entry.status}, not ACTIVE`);
  try {
    enforceEarlyDepartureInHouse({ currentStage: entry.currentStage });
  } catch (e) {
    if (e instanceof AppError) push(e.body.blockingCondition ?? "EARLY_DEPARTURE_NOT_IN_HOUSE", e.message);
    else throw e;
  }
  if (!entry.folio) push("NO_FOLIO", "The booking has no folio");
  else if (entry.folio.state !== FolioState.LIVE) push("FOLIO_NOT_LIVE", `The folio is ${entry.folio.state}, not LIVE`);
  if (!checkIn || !bookedCheckOut) push("NO_STAY_DATES", "The booking has no check-in / checkout dates");
  if (entry.earlyDeparture) push("ALREADY_RECORDED", `An early departure is already recorded (${entry.earlyDeparture.id})`);
  const openExt = entry.stayExtensionRequests[0] ?? null;
  if (openExt) push("STAY_EXTENSION_OPEN", `A stay extension request is open (${openExt.id}, ${openExt.state}) — withdraw it first`);
  if (checkIn && bookedCheckOut) {
    try {
      enforceEarlyDepartureDateWithinStay({ checkIn, bookedCheckOut, departure, hotelToday, allowLater: true });
    } catch (e) {
      if (e instanceof AppError) push("DEPARTURE_DATE", e.message);
      else throw e;
    }
  }

  // --- Slept-night audits (SIG-S8 §1.2: complete for all nights already stayed) ---------------
  // Only nights that have ended are asked for: a departure on a later day leaves tonight and the
  // nights before it to the night audit as usual (2026-11-26).
  const sleptYmds = checkIn ? listNightYmdsUtc(checkIn, departure).filter((ymd) => ymd < ymdUtc(hotelToday)) : [];
  const sleptNightAudits: Array<{ date: string; status: string }> = [];
  const missingNightYmds: string[] = [];
  for (const ymd of sleptYmds) {
    const rec = await prisma.nightAuditRecord.findUnique({ where: { operatingDate: new Date(`${ymd}T00:00:00.000Z`) } });
    // A night posted for this booking alone (a manual run) leaves no hotel record; it counts.
    const postedHere = rec?.runStatus === NightAuditRunStatus.COMPLETE ? true : await isBookingNightPosted(prisma, entryId, new Date(`${ymd}T00:00:00.000Z`));
    const status = rec ? String(rec.runStatus) : postedHere ? "POSTED_FOR_BOOKING" : "MISSING";
    sleptNightAudits.push({ date: ymd, status });
    if (!postedHere) missingNightYmds.push(ymd);
  }
  if (missingNightYmds.length > 0) {
    push(
      "NIGHT_AUDITS_INCOMPLETE",
      `Night audit not complete for the night(s) already stayed: ${missingNightYmds.join(", ")} — run them first`,
    );
  }

  // --- Per-row figures against the commitment snapshot ----------------------------------------
  const { gstRate, serviceChargeRate } = await resolveChargeRates(prisma);
  const taxFactor = new Prisma.Decimal(1).plus(serviceChargeRate).mul(new Prisma.Decimal(1).plus(gstRate));
  const fallbackRate = toDecimal(entry.reservation?.frozenRate ?? 0);
  // Each row's meals, in the proportion the frozen terms priced them — the fee leaves them out.
  const composition = frozenCompositionByRoom([entry.reservation?.frozenCommercialTerms ?? null]);
  const rooms: EarlyDepartureRoomFigure[] = [];
  let forgoneSub = new Prisma.Decimal(0);
  let forgoneTot = new Prisma.Decimal(0);
  let forgoneRoomOnlySub = new Prisma.Decimal(0);
  for (const a of entry.roomAssignments) {
    const rowStart = a.startDate ?? checkIn;
    const rowEnd = a.endDate ?? bookedCheckOut;
    if (!rowStart || !rowEnd) continue;
    const totalNights = nightsBetweenUtc(rowStart, rowEnd);
    const sleptEnd = departure.getTime() < rowEnd.getTime() ? departure : rowEnd;
    const sleptNights = Math.max(0, Math.min(totalNights, nightsBetweenUtc(rowStart, sleptEnd)));
    const unstayedNights = totalNights - sleptNights;
    const shortened = rowEnd.getTime() > departure.getTime() && totalNights > 0 && chosen.has(a.roomId);
    const legacyFlatRate = a.frozenSubtotal == null;
    let perNightSubtotal: Prisma.Decimal;
    let perNightRoomSubtotal: Prisma.Decimal;
    let newFrozenSubtotal: Prisma.Decimal | null = null;
    let newFrozenTotal: Prisma.Decimal | null = null;
    let rowForgoneSub: Prisma.Decimal;
    let rowForgoneTot: Prisma.Decimal;
    const rent = composition.get(a.roomId)?.rent ?? null;
    let rentFix: EarlyDepartureRoomFigure["rentCorrections"] = [];
    if (!legacyFlatRate && totalNights > 0 && rent) {
      // An apartment (2026-11-25, operator: "leaving early then do it as above"): the nights stayed
      // are priced again by the rent rule — whole months or weeks, the rest as their share of the
      // period they fall in — and the period already posted is put right to that. The existing fee
      // is charged on top, as for any stay. ⚠️ Money: the rent rule's own figures, each a line.
      const sub = toDecimal(a.frozenSubtotal);
      const tot = a.frozenTotal != null ? toDecimal(a.frozenTotal) : round2(sub.mul(taxFactor));
      const rule = { serviceChargeApplies: a.isFoc ? false : a.serviceChargeApplies !== false, gstApplies: a.isFoc ? false : a.gstApplies !== false, serviceChargeRate, gstRate };
      const oldRentNet = rent.periods.reduce((t, p) => t.plus(p.net), new Prisma.Decimal(0));
      const oldRentTotal = rent.periods.reduce((t, p) => {
        const x = lineTax(p.net, rule);
        return t.plus(p.net).plus(x.serviceCharge).plus(x.gst);
      }, new Prisma.Decimal(0));
      const keptPeriods = rent.periods.length && sleptNights > 0 && rent.rate ? rentPeriods(rent.plan, rowStart, sleptEnd, rent.rate) : [];
      const newRentNet = keptPeriods.reduce((t, p) => t.plus(p.net), new Prisma.Decimal(0));
      const newRentTotal = keptPeriods.reduce((t, p) => {
        const x = lineTax(p.net, rule);
        return t.plus(p.net).plus(x.serviceCharge).plus(x.gst);
      }, new Prisma.Decimal(0));
      const scale = new Prisma.Decimal(sleptNights).div(totalNights);
      const mealsSub = sub.minus(oldRentNet);
      const mealsTot = tot.minus(oldRentTotal);
      perNightSubtotal = sub.div(totalNights);
      perNightRoomSubtotal = oldRentNet.div(totalNights);
      newFrozenSubtotal = round2(newRentNet.plus(round2(mealsSub.mul(scale))));
      newFrozenTotal = round2(newRentTotal.plus(round2(mealsTot.mul(scale))));
      rowForgoneSub = round2(sub.minus(newFrozenSubtotal));
      rowForgoneTot = round2(tot.minus(newFrozenTotal));
      // Every period whose rent changes — the one the guest leaves in, and any posted ahead of a
      // night not slept (tonight's, posted at check-in), which comes to nothing.
      rentFix = rent.periods
        .map((p) => {
          const kept = keptPeriods.find((k) => k.from === p.from);
          return { periodFrom: p.from, periodTo: p.to, postedNet: Number(p.net), owedNet: kept ? Number(kept.net) : 0, owedWords: kept ? periodWords(kept, rent.plan) : null };
        })
        .filter((x) => x.owedNet !== x.postedNet);
    } else if (!legacyFlatRate && totalNights > 0) {
      const sub = toDecimal(a.frozenSubtotal);
      const tot = a.frozenTotal != null ? toDecimal(a.frozenTotal) : round2(sub.mul(taxFactor));
      perNightSubtotal = sub.div(totalNights);
      const split = splitFrozenRow({ roomId: a.roomId, rowSubtotal: a.frozenSubtotal, rowNights: totalNights, composition: composition.get(a.roomId) });
      perNightRoomSubtotal = split ? split.accommodation.div(totalNights) : perNightSubtotal;
      const scale = new Prisma.Decimal(sleptNights).div(totalNights);
      newFrozenSubtotal = round2(sub.mul(scale));
      newFrozenTotal = round2(tot.mul(scale));
      rowForgoneSub = round2(sub.minus(newFrozenSubtotal));
      rowForgoneTot = round2(tot.minus(newFrozenTotal));
    } else {
      perNightSubtotal = a.isFoc ? new Prisma.Decimal(0) : fallbackRate;
      // The legacy flat rate is the room rate alone — there is no meal in it to take out.
      perNightRoomSubtotal = perNightSubtotal;
      rowForgoneSub = round2(perNightSubtotal.mul(unstayedNights));
      rowForgoneTot = a.isFoc ? new Prisma.Decimal(0) : round2(rowForgoneSub.mul(taxFactor));
    }
    if (shortened) {
      forgoneSub = forgoneSub.plus(rowForgoneSub);
      forgoneTot = forgoneTot.plus(rowForgoneTot);
      forgoneRoomOnlySub = forgoneRoomOnlySub.plus(round2(perNightRoomSubtotal.mul(unstayedNights)));
    }
    rooms.push({
      assignmentId: a.id,
      roomId: a.roomId,
      roomNumber: a.room?.roomNumber ?? null,
      startDate: ymdUtc(rowStart),
      endDate: ymdUtc(rowEnd),
      totalNights,
      sleptNights,
      unstayedNights: shortened ? unstayedNights : 0,
      perNightSubtotal: money(perNightSubtotal),
      perNightRoomSubtotal: money(perNightRoomSubtotal),
      forgoneSubtotal: shortened ? money(rowForgoneSub) : 0,
      forgoneTotal: shortened ? money(rowForgoneTot) : 0,
      newFrozenSubtotal: shortened && newFrozenSubtotal ? money(newFrozenSubtotal) : null,
      newFrozenTotal: shortened && newFrozenTotal ? money(newFrozenTotal) : null,
      legacyFlatRate,
      shortened,
      rentCorrections: shortened ? rentFix : [],
      feeAmount: null,
    });
  }

  const shortRows = rooms.filter((r) => r.shortened);
  const roomsEnd = scope === "ROOMS" && shortRows.length ? new Date(`${shortRows.map((r) => r.endDate).sort().at(-1)}T00:00:00.000Z`) : bookedCheckOut;
  const bookedNights =
    scope === "ROOMS"
      ? Math.max(0, ...shortRows.map((r) => r.totalNights))
      : checkIn && bookedCheckOut
        ? nightsBetweenUtc(checkIn, bookedCheckOut)
        : 0;
  const sleptNightsTotal =
    scope === "ROOMS"
      ? shortRows.length
        ? Math.min(...shortRows.map((r) => r.sleptNights))
        : 0
      : checkIn
        ? Math.min(bookedNights, nightsBetweenUtc(checkIn, departure))
        : 0;
  const unstayedNightsTotal = scope === "ROOMS" ? Math.max(0, ...shortRows.map((r) => r.unstayedNights)) : Math.max(0, bookedNights - sleptNightsTotal);
  const unstayedYmds = roomsEnd && departure.getTime() < roomsEnd.getTime() ? listNightYmdsUtc(departure, roomsEnd) : [];

  // --- Fee (Policy 36 configurable: penalty terms per rate plan) ------------------------------
  const cfg = await requireActiveConfigValue<unknown>(prisma, "earlyDeparture.penalty");
  const rule = resolveEarlyDeparturePenaltyRule(cfg, entry.reservation?.frozenRatePlanId ?? null);
  let feeAmount = new Prisma.Decimal(0);
  let explanation: string;
  // What the fee line says it charges — the guest reads it on the tax invoice (2026-09-18). It
  // used to name the unstayed SPAN ("2 unstayed nights …") beside a one-night figure, which read
  // as two nights charged.
  let charges = "";
  const pct = new Prisma.Decimal(rule.percent).div(100);
  if (unstayedNightsTotal <= 0) {
    explanation = "No unstayed nights — nothing to charge.";
  } else if (rule.basis === "FLAT_AMOUNT") {
    feeAmount = round2(toDecimal(rule.amount));
    explanation = `Flat early-departure fee of ${feeAmount.toFixed(2)} (net).`;
    charges = `for leaving ${nightsWord(unstayedNightsTotal)} early`;
  } else if (rule.basis === "PERCENT_OF_UNSTAYED") {
    // The rooms the stay gives up, not their meals (2026-09-18).
    feeAmount = round2(forgoneRoomOnlySub.mul(pct));
    explanation = `${rule.percent}% of the ${unstayedNightsTotal} unstayed night(s) room charges (${forgoneRoomOnlySub.toFixed(2)} net, meals left out).`;
    charges = `${rule.percent}% of ${nightsWord(unstayedNightsTotal)} not stayed`;
  } else if (rule.basis === "UNSTAYED_NIGHTS") {
    let sum = new Prisma.Decimal(0);
    let chargedNights = 0;
    for (const r of rooms) {
      if (!r.shortened) continue;
      const n = Math.min(rule.nights, r.unstayedNights);
      chargedNights = Math.max(chargedNights, n);
      // The room's night, not its meal plan (2026-09-18) — the family on dinner-inclusive rates was
      // charged a dinner nobody would eat.
      sum = sum.plus(new Prisma.Decimal(r.perNightRoomSubtotal).mul(n));
    }
    feeAmount = round2(sum.mul(pct));
    charges =
      rule.percent === 100
        ? `${nightsWord(chargedNights)} charged for leaving ${nightsWord(unstayedNightsTotal)} early`
        : `${rule.percent}% of ${nightsWord(chargedNights)} for leaving ${nightsWord(unstayedNightsTotal)} early`;
    // Said per room when more than one is shortened — the sum is across the rooms, not one
    // room's nightly figure (2026-09-18).
    const shortenedRooms = rooms.filter((r) => r.shortened).length;
    const basis =
      shortenedRooms > 1
        ? `${nightsWord(chargedNights)} per room at each room's frozen nightly figure, ${shortenedRooms} rooms`
        : `${nightsWord(chargedNights)} at the frozen nightly room figure`;
    explanation =
      rule.percent === 100
        ? `${basis} (${sum.toFixed(2)} net).`
        : `${basis} × ${rule.percent}% (${sum.toFixed(2)} net before the share).`;
  } else {
    explanation = "The early-departure rule is NONE — nothing is charged for the unstayed nights.";
  }
  // Each room's own fee by the same rule (2026-11-26): what a room leaving early, the rest staying,
  // is charged. A flat fee is one per room that leaves. When some rooms leave, the fee IS the sum.
  for (const r of rooms) {
    if (!r.shortened || r.unstayedNights <= 0) continue;
    let f = new Prisma.Decimal(0);
    if (rule.basis === "FLAT_AMOUNT") f = round2(toDecimal(rule.amount));
    else if (rule.basis === "PERCENT_OF_UNSTAYED") f = round2(new Prisma.Decimal(r.perNightRoomSubtotal).mul(r.unstayedNights).mul(pct));
    else if (rule.basis === "UNSTAYED_NIGHTS") f = round2(new Prisma.Decimal(r.perNightRoomSubtotal).mul(Math.min(rule.nights, r.unstayedNights)).mul(pct));
    r.feeAmount = money(f);
  }
  if (scope === "ROOMS") {
    feeAmount = rooms.reduce((t, r) => t.plus(r.feeAmount ?? 0), new Prisma.Decimal(0));
    if (rule.basis === "FLAT_AMOUNT") explanation = `A flat early-departure fee of ${round2(toDecimal(rule.amount)).toFixed(2)} (net) for each room that leaves.`;
  }
  const gross = round2(feeAmount.mul(taxFactor));
  const bookedToWords = bookedCheckOut ? describeNights([ymdUtc(bookedCheckOut)]) : null;
  const span = [describeNights(unstayedYmds), bookedToWords ? `booked to ${bookedToWords}` : null].filter(Boolean).join("; ");
  const description = `Early departure fee · ${charges || `for leaving ${nightsWord(unstayedNightsTotal)} early`}${span ? ` (${span})` : ""}`;

  return {
    entryId,
    scope,
    roomIds: scope === "ROOMS" ? named : [],
    roomsInUse: [...inUse.values()]
      .sort((a, b) => (a.roomNumber ?? "").localeCompare(b.roomNumber ?? "", undefined, { numeric: true }))
      .map((r) => ({
        roomId: r.roomId,
        roomNumber: r.roomNumber,
        roomTypeName: r.roomTypeName,
        endDate: ymdUtc(r.end),
        nightsLeft: nightsBetweenUtc(departure.getTime() > hotelToday.getTime() ? departure : hotelToday, r.end),
        apartment: rentRooms.has(r.roomId),
      })),
    later,
    hotelToday: ymdUtc(hotelToday),
    checkIn: checkIn ? ymdUtc(checkIn) : null,
    bookedCheckOut: bookedCheckOut ? ymdUtc(bookedCheckOut) : null,
    departureDate: ymdUtc(departure),
    bookedNights,
    sleptNights: sleptNightsTotal,
    unstayedNights: unstayedNightsTotal,
    rooms,
    forgoneRoomSubtotal: money(forgoneSub),
    forgoneRoomTotal: money(forgoneTot),
    fee: {
      rule,
      amount: money(feeAmount),
      gross: money(gross),
      serviceChargeRate,
      gstRate,
      description,
      explanation,
    },
    sleptNightAudits,
    missingNightYmds,
    blockers,
    requiredLevel: "L3",
    openStayExtensionRequestId: openExt?.id ?? null,
    alreadyRecorded: entry.earlyDeparture
      ? {
          id: entry.earlyDeparture.id,
          departureDate: ymdUtc(entry.earlyDeparture.departureDate),
          recordedAt: entry.earlyDeparture.recordedAt.toISOString(),
        }
      : null,
  };
}

export async function previewEarlyDeparture(prisma: PrismaClient, entryId: string, input: { departureDate?: string | null; roomIds?: string[] | null }) {
  return computeEarlyDepartureFigures(prisma, entryId, input);
}

export interface EarlyDepartureOutcome {
  record: {
    id: string;
    entryId: string;
    departureDate: string;
    originalCheckOutDate: string;
    sleptNights: number;
    unstayedNights: number;
    feeAmount: number;
    feeWaived: boolean;
  };
  figures: EarlyDepartureFigures;
  feePosted: boolean;
  feeLineId: string | null;
  feeError: string | null;
  /** An apartment's rent periods put right to the nights stayed (2026-11-25), and any that could not be. */
  rentCorrected: Array<{ roomNumber: string | null; periodFrom: string; from: number; to: number; lineId: string | null }>;
  rentErrors: string[];
  movedToCheckout: boolean;
  checkoutBlocked: { code: string; message: string } | null;
  /** The guest leaves on a later day: the stay is shortened now, and checks out then as usual. */
  later: boolean;
  entry: Awaited<ReturnType<typeof loadEntryDetail>>;
}

/**
 * Record the early departure (GM): shorten the stay against the commitment snapshot, post (or
 * waive) the fee, release the unstayed nights, and compress into S8.
 */
export async function recordEarlyDeparture(
  prisma: PrismaClient,
  actor: Actor,
  entryId: string,
  input: { departureDate?: string | null; reason: string; waiveFee?: boolean; waiveReason?: string | null },
): Promise<EarlyDepartureOutcome> {
  enforceEarlyDepartureAuthority({ actorLevel: actor.actorLevel });
  if (!input.reason?.trim()) throw new ValidationError("A reason for the early departure is required");
  if (input.waiveFee && !input.waiveReason?.trim()) throw new ValidationError("Waiving the fee needs a reason");
  await requireActiveMode(prisma, "EARLY_DEPARTURE");

  const figures = await computeEarlyDepartureFigures(prisma, entryId, { departureDate: input.departureDate ?? null });
  if (figures.scope !== "BOOKING") throw new ValidationError("Some rooms leaving is recorded for those rooms — not as the whole booking");
  // The same checks the preview REPORTS are GATES here — the first one names the refusal.
  const hardBlocker = figures.blockers.find((b) => b.code !== "NIGHT_AUDITS_INCOMPLETE");
  if (hardBlocker) {
    if (hardBlocker.code === "DEPARTURE_DATE") throw new ValidationError(hardBlocker.message);
    throw new PolicyGateBlockedError(hardBlocker.code, hardBlocker.message);
  }
  enforceSleptNightsAuditedForEarlyDeparture({ missingNightYmds: figures.missingNightYmds });

  const entry = await loadEntry(prisma, entryId);
  if (!entry.folio) throw new NotFoundError("Folio");
  const folioId = entry.folio.id;
  const departure = new Date(`${figures.departureDate}T00:00:00.000Z`);
  const bookedCheckOut = new Date(`${figures.bookedCheckOut}T00:00:00.000Z`);
  const now = new Date();
  const waived = input.waiveFee === true;
  const feeAmount = waived ? 0 : figures.fee.amount;

  // Timers that describe nights the guest will not be here for: the per-night audit reminders
  // from the departure onward and the checkout-day clock keyed to the old date.
  const candidateTimers = await prisma.timerRecord.findMany({
    where: { entryId, status: "SCHEDULED", timerCode: { in: ["NIGHT_AUDIT_STAY_NIGHT_W37", "CHECKOUT_TIME_W26"] } },
    select: { id: true, timerCode: true, payload: true, pgBossJobId: true },
  });
  const timersToCancel = candidateTimers.filter((t) => {
    if (t.timerCode !== "NIGHT_AUDIT_STAY_NIGHT_W37") return true;
    const iso = (t.payload as { operatingDateIso?: unknown } | null)?.operatingDateIso;
    return typeof iso === "string" ? iso.slice(0, 10) >= figures.departureDate : true;
  });

  const record = await prisma.$transaction(async (tx) => {
    const id = await allocateReadableId(tx, "EARLY_DEPARTURE" as const, now);
    const created = await tx.earlyDepartureRecord.create({
      data: {
        id,
        entryId,
        segmentId: entry.segments[0]?.id ?? null,
        reservationId: entry.reservation?.id ?? null,
        originalCheckOutDate: bookedCheckOut,
        departureDate: departure,
        bookedNights: figures.bookedNights,
        sleptNights: figures.sleptNights,
        unstayedNights: figures.unstayedNights,
        forgoneRoomSubtotal: new Prisma.Decimal(figures.forgoneRoomSubtotal),
        forgoneRoomTotal: new Prisma.Decimal(figures.forgoneRoomTotal),
        rooms: figures.rooms as unknown as Prisma.InputJsonValue,
        feeBasis: {
          rule: figures.fee.rule,
          computedAmount: figures.fee.amount,
          indicativeGross: figures.fee.gross,
          serviceChargeRate: figures.fee.serviceChargeRate,
          gstRate: figures.fee.gstRate,
          explanation: figures.fee.explanation,
          waived,
          waiveReason: waived ? (input.waiveReason?.trim() ?? null) : null,
        } as Prisma.InputJsonValue,
        feeAmount: new Prisma.Decimal(feeAmount),
        feeWaived: waived,
        reason: input.reason.trim(),
        recordedAt: now,
        recordedBy: actor.actorId,
        recordedByLevel: actor.actorLevel,
      },
    });

    // Row surgery — the same shape an in-house room change performs on the vacated room: the row
    // ends on the departure with its frozen figures scaled to the nights it now covers. Per-row
    // updates only (db.ts forbids roomAssignment.updateMany wholesale).
    for (const r of figures.rooms) {
      if (!r.shortened) continue;
      const rowStart = new Date(`${r.startDate}T00:00:00.000Z`);
      const newEnd = departure.getTime() > rowStart.getTime() ? departure : rowStart;
      await tx.roomAssignment.update({
        where: { id: r.assignmentId },
        data: {
          startDate: rowStart,
          endDate: newEnd,
          ...(r.newFrozenSubtotal != null ? { frozenSubtotal: new Prisma.Decimal(r.newFrozenSubtotal) } : {}),
          ...(r.newFrozenTotal != null ? { frozenTotal: new Prisma.Decimal(r.newFrozenTotal) } : {}),
        },
      });
      // A room the guest was due to move INTO later (a scheduled per-night move) is never entered
      // now — let its forward claim flag go. Occupied rooms are released by the checkout itself.
      if (r.sleptNights === 0) {
        await transitionRoomClaimState(tx, {
          roomId: r.roomId,
          toState: InventoryClaimState.FREE,
          actorId: actor.actorId,
          entryId,
          reason: "EARLY_DEPARTURE_UNENTERED_ROOM",
          onlyFromStates: [InventoryClaimState.CONFIRMED, InventoryClaimState.COMMITTED_HELD],
          now,
        });
      }
    }

    await tx.entry.update({
      where: { id: entryId },
      data: { actualCheckOutDate: departure, checkOutDate: departure, version: { increment: 1 }, updatedAt: now },
    });

    if (timersToCancel.length > 0) {
      await tx.timerRecord.updateMany({
        where: { id: { in: timersToCancel.map((t) => t.id) }, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actor.actorId, cancelledReason: "EARLY_DEPARTURE" },
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.EARLY_DEPARTURE_RECORDED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          recordId: created.id,
          departureDate: figures.departureDate,
          bookedCheckOut: figures.bookedCheckOut,
          bookedNights: figures.bookedNights,
          sleptNights: figures.sleptNights,
          unstayedNights: figures.unstayedNights,
          forgoneRoomSubtotal: figures.forgoneRoomSubtotal,
          forgoneRoomTotal: figures.forgoneRoomTotal,
          feeAmount,
          feeWaived: waived,
          feeBasis: figures.fee.rule.basis,
          rooms: figures.rooms
            .filter((r) => r.shortened)
            .map((r) => ({ roomId: r.roomId, roomNumber: r.roomNumber, sleptNights: r.sleptNights, unstayedNights: r.unstayedNights })),
          timersCancelled: timersToCancel.map((t) => t.timerCode),
          reason: input.reason.trim(),
          mode: "EARLY_DEPARTURE",
        },
        createdBy: actor.actorId,
      },
    });

    return created;
  });

  // pg-boss side of the cancelled timers — best-effort, the rows are already CANCELLED.
  if (timersToCancel.some((t) => t.pgBossJobId)) {
    void Promise.resolve().then(async () => {
      try {
        const engine = await getTimerEngine();
        await Promise.all(timersToCancel.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
      } catch {
        // best-effort
      }
    });
  }

  // --- An apartment's rent, put right to the nights stayed (2026-11-25) -------------------------
  // The period the guest leaves in was posted whole on its first night; it is corrected to the rent
  // of the nights stayed, with its service charge and GST moving with it. ⚠️ Money.
  const rentCorrected: Array<{ roomNumber: string | null; periodFrom: string; from: number; to: number; lineId: string | null }> = [];
  const rentErrors: string[] = [];
  for (const r of figures.rooms) {
    for (const c of r.rentCorrections ?? []) {
      try {
        const line = await prisma.folioLine.findFirst({
          where: {
            folioId,
            roomId: r.roomId,
            lineType: FolioLineType.ROOM_CHARGE,
            chargeDate: new Date(`${c.periodFrom}T00:00:00.000Z`),
            description: { startsWith: NIGHT_AUDIT_ROOM_CHARGE_DESCRIPTION_PREFIX },
          },
          orderBy: { postedAt: "asc" },
          select: { id: true },
        });
        if (!line) {
          // Not posted yet, and nothing owed for it: nothing to put right.
          if (c.owedNet === 0) continue;
          rentErrors.push(`Room ${r.roomNumber ?? ""}: the rent from ${c.periodFrom} is not on the bill to put right`);
          continue;
        }
        const out = await correctCharge(prisma, folioId, actor.actorId, {
          entryId,
          originalFolioLineId: line.id,
          reason: `Left early — the rent for the nights stayed${c.owedWords ? `: ${c.owedWords}` : ""}`,
          correctToAmount: c.owedNet,
          correctionDate: figures.departureDate,
        });
        rentCorrected.push({ roomNumber: r.roomNumber, periodFrom: c.periodFrom, from: c.postedNet, to: c.owedNet, lineId: (out as { id?: string } | null)?.id ?? null });
      } catch (e) {
        rentErrors.push(e instanceof Error ? e.message : String(e));
      }
    }
  }

  // --- The fee, on the live folio (still S7 here) ---------------------------------------------
  let feePosted = false;
  let feeLineId: string | null = null;
  let feeError: string | null = null;
  if (!waived && feeAmount > 0) {
    try {
      // The fee is a term of the stay as booked — one unstayed night — so it is owed by whoever
      // pays the room (the agency's package, the company's account), not charged to the guest's
      // own share as a SERVICE line would be by default (2026-09-18).
      const stayPayer = await resolveBillingModelForNewLine(prisma as never, folioId, FolioLineType.ROOM_CHARGE);
      const line = await postCharge(prisma, folioId, actor.actorId, {
        entryId,
        lineType: FolioLineType.SERVICE,
        description: figures.fee.description,
        amount: feeAmount,
        currency: "BTN",
        // A charge is never dated ahead of today: a departure on a later day posts its fee today.
        chargeDate: `${figures.later ? figures.hotelToday : figures.departureDate}T00:00:00.000Z`,
        allowSoftGateBypass: true,
        billingModelOverride: stayPayer,
      });
      feeLineId = (line as { id?: string } | null)?.id ?? null;
      feePosted = true;
      await prisma.earlyDepartureRecord.update({ where: { id: record.id }, data: { feeFolioLineId: feeLineId } });
    } catch (e) {
      feeError = e instanceof Error ? e.message : String(e);
      await prisma.traceEvent
        .create({
          data: {
            eventType: "ENTRY.EARLY_DEPARTURE_FEE_NOT_POSTED",
            actorId: actor.actorId,
            actorLevel: actor.actorLevel,
            entityType: "Entry",
            entityId: entryId,
            operation: "ALERT",
            timestamp: new Date(),
            stageContext: Stage.S7,
            inquiryId: entry.inquiryId,
            entryId,
            payload: { recordId: record.id, feeAmount, error: feeError },
            createdBy: actor.actorId,
          },
        })
        .catch(() => {});
    }
  }

  // Tonight, if it was posted ahead (at check-in, or by the desk), is no longer a night of the stay —
  // its lines go to zero before the move to Check-out (2026-10-29). On a later departure tonight is
  // still slept, and the booking stays at Stay until that day's check-out (2026-11-26).
  if (!figures.later) {
    const { reconcileTonightBestEffort } = await import("../application/s7-night-audit-service.js");
    await reconcileTonightBestEffort(prisma, {
      entryId,
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      reason: "Left early — tonight is not a night of the stay",
    });
  }

  // --- Compression into S8 (SIG-S8 §1.2: "Early Departure mode compresses S7→S8") -------------
  let movedToCheckout = false;
  let checkoutBlocked: { code: string; message: string } | null = null;
  if (!figures.later) try {
    const fresh = await prisma.entry.findUnique({ where: { id: entryId }, select: { version: true } });
    await progressStageS7ToS8(prisma, entryId, actor.actorId, fresh?.version);
    movedToCheckout = true;
  } catch (e) {
    checkoutBlocked =
      e instanceof AppError
        ? { code: e.body.blockingCondition ?? e.body.error, message: e.message }
        : { code: "UNKNOWN", message: e instanceof Error ? e.message : String(e) };
  }

  return {
    record: {
      id: record.id,
      entryId,
      departureDate: figures.departureDate,
      originalCheckOutDate: figures.bookedCheckOut ?? "",
      sleptNights: figures.sleptNights,
      unstayedNights: figures.unstayedNights,
      feeAmount,
      feeWaived: waived,
    },
    figures,
    feePosted,
    feeLineId,
    feeError,
    rentCorrected,
    rentErrors,
    movedToCheckout,
    checkoutBlocked,
    later: figures.later,
    entry: await loadEntryDetail(prisma, entryId),
  };
}
