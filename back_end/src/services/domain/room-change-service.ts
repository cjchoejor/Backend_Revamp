import type { PrismaClient } from "@prisma/client";
import { HandoffState, HandoffType, InventoryClaimState, Prisma, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { foldIsoNightsToRanges } from "../../lib/entry-inventory-claim.js";
import { findRoomBookingConflicts, type RoomBookingConflict } from "../../lib/room-booking-conflicts.js";
import { resolveOperativeQuotation } from "../../lib/operative-quotation.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { transitionRoomClaimState } from "../../lib/room-claim-state.js";
import { cancelEntryTimersByCode } from "../../lib/cancel-entry-timers-by-code.js";
import { readHandoffChecklistContent } from "../../lib/handoff-checklist.js";
import { hydrateRoomAssignmentComposition } from "../../lib/hydrate-room-assignment-composition.js";
import {
  enforceNoOverlappingBookingForCommittedHold,
  enforceCommittedHoldRoomPhysicallyUsable,
} from "../../policies/11-committed-hold/p26-committed-hold-inventory-availability.js";
import {
  enforceRepriceAuthorityForStage,
  enforceRoomChangeAuthorityForStage,
} from "../../policies/23-room-change/p58-room-change-mode-trigger.js";
import { enforceEntryActiveForStageTransition } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { enforceRoomPhysicallyAssignableForS5 } from "../../policies/01-availability/p01-s5-room-assignment-eligibility-gates.js";
import { backflowRoomChangeToS2 } from "../../state-machines/backflows-state-machine.js";
import { progressS2ToS3 } from "../../state-machines/s2-s3-state-machine.js";
import { progressStageS5ToS6 } from "../../state-machines/entry-lifecycle-state-machine.js";
import * as s3HoldService from "./s3-hold-service.js";
import { ROOM_BED_TYPES, bedTypeConversionGroup, setRoomBedType, type RoomBedType } from "./room-bed-type-service.js";
import {
  createQuotation,
  enforceRoomCompositionsPriceable,
  type QuotationDraftInput,
  type RoomCompositionServiceInput,
} from "./s2-quotation-service.js";
import { confirmReservation } from "./s4-confirmation-service.js";
import { recordCommunicationAcknowledgement } from "./communication-acknowledgement-service.js";
import { assignRoomsFromSealedPerNight } from "./room-assignment-service.js";
import { runPreArrivalWindowActivationWorker } from "../../workers/w4-pre-arrival-window-activation-worker.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";

/**
 * IN-PLACE ROOM CHANGE (2026-08-12 operator ruling) — one desk action, the full governed
 * journey in the backend.
 *
 * The operator changes one room of the booking from whatever step they are on (S5 Arrival,
 * S6 Check-in, S7 Stay) without leaving the page. The backend runs everything the lifecycle
 * demands, exactly as if the booking had walked back to the start and forward again:
 *
 *   1. Governed ROOM_CHANGE re-entry → NEW SEGMENT opening at S2 (every room change rolls a
 *      segment — same-type or cross-type; SIG-S7 §84 / AC-S7-20, confirmed by the operator).
 *   2. The prior basis is carried over with ONE room substituted, and the substitute is
 *      revalidated against live availability with the SAME predicates S1 uses
 *      (`findRoomBookingConflicts` + p26 physical usability) — "in the backend it should be
 *      as if it's starting from S1".
 *   3. A quotation is minted SILENTLY as the new segment's priced basis (the segment-scoped
 *      S2-exit gate and the S4 re-freeze require one, and for a cross-type change the new
 *      price has to live somewhere) — but nothing is sent to the guest. Generate-vs-send:
 *      the desk offers Send only if the guest asks for the bill. The proforma is NOT
 *      re-issued and the advance already received stands (operator ruling).
 *   4. The walk back to the origin stage runs server-side: S2→S3 (hold re-placed on the
 *      substituted selection), S3→S4 (re-freeze; new Reservation row for the new segment;
 *      the new voucher's answer is recorded as the guest's room-change request itself),
 *      then S4→origin (W4 funnel for S5/S6 origins; a compressed SIG-S6 §102 return for the
 *      in-house S7 origin — the arrival ceremony is not re-run mid-stay).
 *
 * PARTIAL-OUTCOME CONTRACT (mirrors `duplicateSegmentIntoNew`): the re-entry commits first
 * and is irreversible. If a later step blocks (e.g. the advance evaluation refuses the
 * re-freeze), the call still resolves with `walk.blocked` naming the stage and reason — the
 * new segment is real, the substituted basis is sealed, and the operator finishes the
 * remaining steps through the normal desk flow (which now reads the substituted rooms).
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };

const DAY_MS = 86_400_000;

/**
 * In-house (S7) fidelity for an in-place change: the new setup applies from TONIGHT, so the
 * nights the guest has ALREADY slept are pinned to what they were, as per-night overrides on
 * the room's single composition row (every consumer keys compositions by roomId, so splitting
 * the row is not an option). The quotation then prices slept nights as they were charged and
 * remaining nights as asked, and the stay total still reconciles with the folio.
 *
 * Meals and the extra-bed count are the only things a per-night override can carry — a
 * negotiated RATE cannot be expressed per night, which is exactly why a mid-stay rate change
 * is a GM decision (p58 `enforceRepriceAuthorityForStage`) and why the desk warns that
 * already-posted nights need a folio correction rather than being silently re-billed.
 *
 * Shared by the field-patch path (`adjustments`) and the full-table re-price so the two
 * cannot disagree about what a slept night cost.
 */
function pinSleptNightsToPriorSetup(
  row: RoomCompositionServiceInput,
  prior: { composition: RoomCompositionServiceInput | null; mealsChanged: boolean; bedsChanged: boolean },
  sleptNights: string[],
): void {
  if (sleptNights.length === 0 || (!prior.mealsChanged && !prior.bedsChanged)) return;
  const priorOverrides = prior.composition?.nightMealOverrides ?? [];
  const priorMeals = {
    mealPlanCpCount: prior.composition?.mealPlanCpCount ?? 0,
    mealPlanMaplCount: prior.composition?.mealPlanMaplCount ?? 0,
    mealPlanMapdCount: prior.composition?.mealPlanMapdCount ?? 0,
    mealPlanApCount: prior.composition?.mealPlanApCount ?? 0,
    mealPlanOthersCount: prior.composition?.mealPlanOthersCount ?? 0,
    othersBreakfastPax: prior.composition?.othersBreakfastPax ?? 0,
    othersLunchPax: prior.composition?.othersLunchPax ?? 0,
    othersDinnerPax: prior.composition?.othersDinnerPax ?? 0,
  };
  const priorBeds = prior.composition?.extraBedCount ?? 0;
  const keep = [...(row.nightMealOverrides ?? [])].filter((o) => !sleptNights.includes(String(o.date).slice(0, 10)));
  for (const date of sleptNights) {
    const own = priorOverrides.find((o) => String(o.date).slice(0, 10) === date) ?? null;
    // That night's own exception wins over the room default when one existed.
    const meals = prior.mealsChanged
      ? own
        ? {
            mealPlanCpCount: own.mealPlanCpCount ?? 0,
            mealPlanMaplCount: own.mealPlanMaplCount ?? 0,
            mealPlanMapdCount: own.mealPlanMapdCount ?? 0,
            mealPlanApCount: own.mealPlanApCount ?? 0,
            mealPlanOthersCount: own.mealPlanOthersCount ?? 0,
            othersBreakfastPax: own.othersBreakfastPax ?? 0,
            othersLunchPax: own.othersLunchPax ?? 0,
            othersDinnerPax: own.othersDinnerPax ?? 0,
          }
        : priorMeals
      : own
        ? {
            mealPlanCpCount: own.mealPlanCpCount,
            mealPlanMaplCount: own.mealPlanMaplCount,
            mealPlanMapdCount: own.mealPlanMapdCount,
            mealPlanApCount: own.mealPlanApCount,
            mealPlanOthersCount: own.mealPlanOthersCount,
            othersBreakfastPax: own.othersBreakfastPax,
            othersLunchPax: own.othersLunchPax,
            othersDinnerPax: own.othersDinnerPax,
          }
        : {};
    keep.push({
      date: `${date}T00:00:00.000Z`,
      ...meals,
      ...(prior.bedsChanged ? { extraBedCount: priorBeds } : {}),
    });
  }
  keep.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  row.nightMealOverrides = keep;
}

function isoNightsBetween(checkIn: Date, checkOut: Date): string[] {
  const out: string[] = [];
  const start = Date.UTC(checkIn.getUTCFullYear(), checkIn.getUTCMonth(), checkIn.getUTCDate());
  const end = Date.UTC(checkOut.getUTCFullYear(), checkOut.getUTCMonth(), checkOut.getUTCDate());
  for (let t = start; t < end; t += DAY_MS) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

function todayUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Per-night picture of the booking's CURRENT room basis, normalised across the three seal shapes. */
function currentPerNightPicture(input: {
  sealedOption: unknown;
  fallbackRoomIds: string[];
  nightsIso: string[];
}): Array<{ date: string; roomIds: string[] }> {
  const sel = readOptionSelected(input.sealedOption ?? null);
  if (sel.perNight && sel.perNight.length > 0) {
    return sel.perNight.map((n) => ({ date: String(n.date).slice(0, 10), roomIds: [...n.roomIds] }));
  }
  const rooms = sel.distinctRoomIds.length > 0 ? sel.distinctRoomIds : input.fallbackRoomIds;
  return input.nightsIso.map((date) => ({ date, roomIds: [...rooms] }));
}

export type RoomChangeCandidate = {
  roomId: string;
  roomNumber: string;
  roomTypeId: string;
  roomTypeName: string | null;
  bedType: string | null;
  sameType: boolean;
  physicalState: string;
  isDeficient: boolean;
  /** Nights the change would claim this room for (the from-room's nights; S7 → from tonight). */
  nights: number;
  /**
   * The room's standing over the substitution nights, in the S1 availability vocabulary
   * (2026-08-13, operator request — "show the status of the room like in S1"): FREE rooms are
   * pickable; the rest are shown with WHY they are not, so the operator sees the same picture
   * the S1 table would paint instead of unavailable rooms silently missing from the list.
   */
  availability: "FREE" | "RESERVED" | "HELD" | "BLOCKED" | "MAINTENANCE";
  /** Only FREE rooms can be picked — the others are display-only context. */
  selectable: boolean;
  /** Authority the pick needs (p58): same-type L1, cross-type (upgrade/downgrade) L2. */
  requiredLevel: "L1" | "L2";
  /** Who claims the room, when RESERVED/HELD — same context S1's cell tooltips carry. */
  claimedBy: {
    guestName: string | null;
    bookingRef: string | null;
    startDate: string;
    endDate: string;
    holdKind: "COMMITTED" | "SPECULATIVE" | null;
  } | null;
  /** The recorded reason, when BLOCKED. */
  blockedReason: string | null;
  /**
   * Night-by-night standing over the substitution nights (2026-08-14, operator request — the
   * single `availability` states the WORST night; this states WHICH nights, with dates, so a
   * multi-night stay sees the whole picture, not just check-in night). Same vocabulary as the
   * S1 table's cells; a room taken on one night of three shows two FREE nights and one claimed.
   */
  perNight: Array<{
    date: string;
    status: "FREE" | "RESERVED" | "HELD" | "BLOCKED" | "MAINTENANCE";
    claimedBy: { guestName: string | null; bookingRef: string | null; holdKind: "COMMITTED" | "SPECULATIVE" | null } | null;
  }>;
  /** How many of the substitution nights this room is actually free on. */
  freeNightCount: number;
};

export type RoomChangeCandidatesResult = {
  entryId: string;
  originStage: string;
  fromRoom: { roomId: string; roomNumber: string; roomTypeId: string; roomTypeName: string | null };
  /** ISO nights the substitution would cover — the from-room's claimed nights (S7: from tonight). */
  substitutionNights: string[];
  candidates: RoomChangeCandidate[];
};

/** Shared context both the candidates lookup and the change itself derive once. */
async function loadRoomChangeContext(prisma: PrismaClient, entryId: string, fromRoomId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      segments: { orderBy: { segmentNumber: "desc" } },
      quotations: { orderBy: { createdAt: "desc" } },
      committedHold: true,
      reservation: true,
      roomAssignments: { orderBy: { createdAt: "desc" }, include: { room: true } },
      availabilityConfigs: {
        where: { sealedAt: { not: null }, optionSelected: { not: Prisma.DbNull } },
        orderBy: { sealedAt: "desc" },
        take: 1,
      },
      guestProfile: true,
      folio: true,
    },
  });
  if (!entry) throw new NotFoundError("Entry");

  const stage = entry.currentStage;
  if (stage !== Stage.S5 && stage !== Stage.S6 && stage !== Stage.S7) {
    throw new ValidationError(`A room change runs from Arrival, Check-in or Stay (S5–S7) — this booking is at ${stage}`);
  }
  enforceEntryActiveForStageTransition({ status: entry.status });

  const checkIn = entry.reservation?.frozenCheckInDate ?? entry.checkInDate;
  const checkOut = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate;
  if (!checkIn || !checkOut) throw new ValidationError("This booking has no stay dates — a room change cannot be validated");
  const nightsIso = isoNightsBetween(checkIn, checkOut);
  if (nightsIso.length === 0) throw new ValidationError("This booking has no stay nights left to change");

  const sealedConfig = entry.availabilityConfigs[0] ?? null;
  const fallbackRoomIds = Array.from(
    new Set([
      ...s3HoldServiceHeldRooms(entry.committedHold),
      ...entry.roomAssignments.map((a) => a.roomId),
    ]),
  );
  const picture = currentPerNightPicture({
    sealedOption: sealedConfig?.optionSelected ?? null,
    fallbackRoomIds,
    nightsIso,
  });

  const claimedRoomIds = new Set(picture.flatMap((n) => n.roomIds));
  if (!claimedRoomIds.has(fromRoomId)) {
    throw new ValidationError("That room is not part of this booking's current room plan");
  }

  // Nights the substitution covers: all of the from-room's nights — except in-house (S7),
  // where slept nights stay with the old room and the change runs from tonight onward.
  const today = todayUtcMidnight();
  const todayIso = today.toISOString().slice(0, 10);
  const substitutionNights = picture
    .filter((n) => n.roomIds.includes(fromRoomId))
    .map((n) => n.date)
    .filter((date) => (stage === Stage.S7 ? date >= todayIso : true));
  if (substitutionNights.length === 0) {
    throw new ValidationError("There are no remaining nights on that room to change — the stay is past them");
  }

  const fromRoom = await prisma.room.findUnique({ where: { id: fromRoomId }, include: { roomType: true } });
  if (!fromRoom) throw new NotFoundError("Room");

  return { entry, stage, checkIn, checkOut, nightsIso, sealedConfig, picture, claimedRoomIds, substitutionNights, today, todayIso, fromRoom };
}

/** Rooms the hold currently covers (perNightBreakdown + primary roomId), tolerant of null. */
function s3HoldServiceHeldRooms(hold: { roomId: string | null; perNightBreakdown?: Prisma.JsonValue | null } | null): string[] {
  if (!hold) return [];
  const out = new Set<string>();
  if (hold.roomId) out.add(hold.roomId);
  const pn = hold.perNightBreakdown;
  if (Array.isArray(pn)) {
    for (const night of pn as Array<{ roomIds?: Array<{ roomId?: string }> }>) {
      for (const r of night?.roomIds ?? []) if (typeof r?.roomId === "string") out.add(r.roomId);
    }
  }
  return [...out];
}

/**
 * Rooms the operator could move `fromRoomId` to: every registered non-shadow room outside the
 * booking, each carrying its S1-style standing over the substitution nights (2026-08-13 —
 * previously unavailable rooms were silently dropped; now they are listed with WHY, exactly
 * like the S1 availability table: reserved / held / blocked / maintenance). Only FREE rooms
 * are selectable; availability is judged with the SAME predicates S1's search and Policy 26
 * use, so what this list calls FREE the change itself will accept.
 */
export async function listRoomChangeCandidates(
  prisma: PrismaClient,
  entryId: string,
  fromRoomId: string,
): Promise<RoomChangeCandidatesResult> {
  const ctx = await loadRoomChangeContext(prisma, entryId, fromRoomId);
  const ranges = foldIsoNightsToRanges(ctx.substitutionNights);

  const rooms = await prisma.room.findMany({
    where: { isShadowInventory: false },
    include: { roomType: true },
    orderBy: { roomNumber: "asc" },
  });

  const pool = rooms.filter((r) => r.id !== fromRoomId && !ctx.claimedRoomIds.has(r.id));

  // Physical usability (cheap, in-memory — the same predicate the change enforces), classified
  // rather than filtered: a blocked room stays visible AS blocked.
  const physicalStatusById = new Map<string, "BLOCKED" | "MAINTENANCE">();
  for (const r of pool) {
    try {
      for (const range of ranges) {
        enforceCommittedHoldRoomPhysicallyUsable({
          roomNumber: r.roomNumber,
          isBlocked: r.isBlocked,
          blockedReason: r.blockedReason,
          isUnderMaintenance: r.isUnderMaintenance,
          maintenanceDeadline: r.maintenanceDeadline,
          checkIn: range.startDate,
          checkOut: range.endDate,
        });
      }
    } catch {
      physicalStatusById.set(r.id, r.isBlocked ? "BLOCKED" : "MAINTENANCE");
    }
  }

  // One conflict query per folded range for the whole pool — keeping EVERY conflict per room
  // (2026-08-14: the per-night strip needs all of them, not just the strongest). Deduped per
  // (room, source, span) so a claim covering two folded ranges isn't counted twice.
  const conflictsByRoom = new Map<string, RoomBookingConflict[]>();
  for (const range of ranges) {
    const conflicts = await findRoomBookingConflicts(prisma, {
      roomIds: pool.map((r) => r.id),
      checkIn: range.startDate,
      checkOut: range.endDate,
      excludeEntryId: entryId,
    });
    for (const c of conflicts) {
      const list = conflictsByRoom.get(c.roomId) ?? [];
      if (!list.some((p) => p.source === c.source && p.startDate.getTime() === c.startDate.getTime() && p.endDate.getTime() === c.endDate.getTime())) {
        list.push(c);
      }
      conflictsByRoom.set(c.roomId, list);
    }
  }
  // Half-open [startDate, endDate) — checkout day is not a stay night, matching the S1 table.
  const claimCoversNight = (c: RoomBookingConflict, date: string) =>
    c.startDate.toISOString().slice(0, 10) <= date && date < c.endDate.toISOString().slice(0, 10);

  const candidates: RoomChangeCandidate[] = pool
    .map((r) => {
      const physical = physicalStatusById.get(r.id) ?? null;
      const roomConflicts = conflictsByRoom.get(r.id) ?? [];
      // Strongest claim overall for the one-line summary (reservation outranks a hold,
      // mirroring the S1 engine's occupied-over-held collapse).
      const claim = roomConflicts.find((c) => c.source === "RESERVED") ?? roomConflicts[0] ?? null;
      const perNight: RoomChangeCandidate["perNight"] = ctx.substitutionNights.map((date) => {
        if (physical) return { date, status: physical, claimedBy: null };
        const covering = roomConflicts.filter((c) => claimCoversNight(c, date));
        const strongest = covering.find((c) => c.source === "RESERVED") ?? covering[0] ?? null;
        return {
          date,
          status: strongest ? (strongest.source === "RESERVED" ? ("RESERVED" as const) : ("HELD" as const)) : ("FREE" as const),
          claimedBy: strongest
            ? {
                guestName: strongest.guestName ?? null,
                bookingRef: strongest.entryReferenceNumber ?? null,
                holdKind: strongest.holdKind ?? null,
              }
            : null,
        };
      });
      const freeNightCount = perNight.filter((n) => n.status === "FREE").length;
      const availability: RoomChangeCandidate["availability"] =
        physical ?? (claim ? (claim.source === "RESERVED" ? "RESERVED" : "HELD") : "FREE");
      const sameType = r.roomTypeId === ctx.fromRoom.roomTypeId;
      return {
        roomId: r.id,
        roomNumber: r.roomNumber,
        roomTypeId: r.roomTypeId,
        roomTypeName: r.roomType?.name ?? null,
        bedType: (r as { bedType?: string | null }).bedType ?? null,
        sameType,
        physicalState: String(r.physicalState),
        isDeficient: r.isDeficient === true,
        nights: ctx.substitutionNights.length,
        availability,
        selectable: availability === "FREE",
        requiredLevel: (sameType ? "L1" : "L2") as "L1" | "L2",
        claimedBy:
          availability === "RESERVED" || availability === "HELD"
            ? {
                guestName: claim?.guestName ?? null,
                bookingRef: claim?.entryReferenceNumber ?? null,
                startDate: claim!.startDate.toISOString(),
                endDate: claim!.endDate.toISOString(),
                holdKind: claim?.holdKind ?? null,
              }
            : null,
        blockedReason: availability === "BLOCKED" ? (r.blockedReason ?? null) : null,
        perNight,
        freeNightCount,
      };
    })
    // Same-type first (the common case: equivalent room, price unchanged), then free rooms
    // before the merely-informative ones, then by room number.
    .sort(
      (a, b) =>
        Number(b.sameType) - Number(a.sameType) ||
        Number(b.selectable) - Number(a.selectable) ||
        a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }),
    );

  return {
    entryId,
    originStage: String(ctx.stage),
    fromRoom: {
      roomId: ctx.fromRoom.id,
      roomNumber: ctx.fromRoom.roomNumber,
      roomTypeId: ctx.fromRoom.roomTypeId,
      roomTypeName: ctx.fromRoom.roomType?.name ?? null,
    },
    substitutionNights: ctx.substitutionNights,
    candidates,
  };
}

export type RoomPlanHistoryItem = {
  /** A room in the booking's CURRENT plan (latest sealed selection + hold + assignments). */
  currentRoomId: string;
  currentRoomNumber: string | null;
  currentRoomTypeName: string | null;
  currentBedType: string | null;
  /**
   * The room this slot of the plan STARTED as — the first sealed selection, followed through
   * the room-change chain. Null when the origin cannot be established (legacy bookings whose
   * plan was re-built without the in-place change's from→to markers).
   */
  initialRoomId: string | null;
  initialRoomNumber: string | null;
  initialRoomTypeName: string | null;
  /** The initial room's bed setup AT SELECTION TIME (trace-reconstructed — the registry moves). */
  initialBedType: string | null;
  roomChanged: boolean;
  /** Same room, different bed setup than when it was selected. */
  bedTypeChanged: boolean;
  /** The from→to steps that led here, oldest first. */
  changes: Array<{ fromRoomNumber: string | null; toRoomNumber: string | null; at: string; reason: string | null }>;
};

export type RoomPlanHistoryResult = {
  entryId: string;
  /** When the initial selection was sealed (first sealed config; earliest assignment as fallback). */
  initialSelectedAt: string | null;
  rooms: RoomPlanHistoryItem[];
};

/**
 * WHAT WAS INITIALLY SELECTED — the durable answer behind the S5–S7 room tables' "Initially"
 * column (2026-08-13, operator request: after a room change or a bed-type change, the table
 * must keep stating what the FIRST selection was).
 *
 * Pure read, nothing persisted. Sources are all immutable history:
 *  - the FIRST sealed AvailabilityConfiguration = the initial room selection;
 *  - every later sealed config written by the in-place room change carries a
 *    `roomChange {fromRoomId, toRoomId}` marker — folding those forward maps each CURRENT
 *    room back to the room it started as;
 *  - `ROOM.BED_TYPE_CHANGED` traces (which record the PRIOR value) reconstruct each initial
 *    room's bed setup as it stood at selection time — the registry row itself only knows the
 *    present.
 */
export async function buildRoomPlanHistory(prisma: PrismaClient, entryId: string): Promise<RoomPlanHistoryResult> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      committedHold: true,
      roomAssignments: { orderBy: { createdAt: "asc" } },
      availabilityConfigs: {
        where: { sealedAt: { not: null }, optionSelected: { not: Prisma.DbNull } },
        orderBy: { sealedAt: "asc" },
      },
    },
  });
  if (!entry) throw new NotFoundError("Entry");

  const configs = entry.availabilityConfigs;
  const firstConfig = configs[0] ?? null;
  const latestConfig = configs.length > 0 ? configs[configs.length - 1] : null;

  // Current plan = latest sealed picture, plus hold + assignment rooms (covers bookings whose
  // plan never went through a sealed config, and the S7 split where both rooms have rows).
  const latestSel = readOptionSelected(latestConfig?.optionSelected ?? null);
  const currentRoomIds = Array.from(
    new Set<string>([
      ...latestSel.distinctRoomIds,
      ...s3HoldServiceHeldRooms(entry.committedHold),
      ...entry.roomAssignments.map((a) => a.roomId),
    ]),
  );

  // Initial selection: first sealed config; earliest assignments as the legacy fallback.
  const firstSel = readOptionSelected(firstConfig?.optionSelected ?? null);
  let initialRoomIds = [...firstSel.distinctRoomIds];
  let initialSelectedAt: Date | null = firstConfig?.sealedAt ?? null;
  if (initialRoomIds.length === 0 && entry.roomAssignments.length > 0) {
    initialRoomIds = Array.from(new Set(entry.roomAssignments.map((a) => a.roomId)));
    initialSelectedAt = entry.roomAssignments[0].createdAt;
  }

  // Fold the change chain forward: originOf[current] = the initial room it descends from.
  const originOf = new Map<string, string>();
  for (const id of initialRoomIds) originOf.set(id, id);
  const chain: Array<{ fromRoomId: string; toRoomId: string; at: Date; reason: string | null }> = [];
  for (const cfg of configs) {
    const marker = (cfg.optionSelected as { roomChange?: { fromRoomId?: unknown; toRoomId?: unknown; toRoomIds?: unknown } } | null)
      ?.roomChange;
    const fromRoomId = typeof marker?.fromRoomId === "string" ? marker.fromRoomId : null;
    const toRoomId = typeof marker?.toRoomId === "string" ? marker.toRoomId : null;
    // A per-night change can substitute one room with SEVERAL (2026-08-14) — `toRoomIds`
    // carries the full set, `toRoomId` only the primary. Fold EVERY target back to the origin,
    // or the non-primary rooms read "Initially: not recorded" (the reported 202→501+302 case).
    const toRoomIds = Array.isArray(marker?.toRoomIds)
      ? (marker!.toRoomIds as unknown[]).filter((v): v is string => typeof v === "string")
      : [];
    const targets = toRoomIds.length > 0 ? toRoomIds : toRoomId ? [toRoomId] : [];
    if (!fromRoomId || targets.length === 0) continue;
    const criteria = cfg.searchCriteria as { roomChange?: { reason?: unknown } } | null;
    const reason = typeof criteria?.roomChange?.reason === "string" ? criteria.roomChange.reason : null;
    for (const target of targets) {
      chain.push({ fromRoomId, toRoomId: target, at: cfg.sealedAt ?? cfg.createdAt, reason });
      originOf.set(target, originOf.get(fromRoomId) ?? fromRoomId);
    }
  }

  // Single-room fallback: one room in, one room out — the origin is the one initial room even
  // when the swap happened outside the marker-writing path (e.g. S5 "pick another of this type").
  if (currentRoomIds.length === 1 && initialRoomIds.length === 1 && !originOf.has(currentRoomIds[0])) {
    originOf.set(currentRoomIds[0], initialRoomIds[0]);
  }

  const involvedIds = Array.from(new Set([...currentRoomIds, ...initialRoomIds, ...chain.flatMap((c) => [c.fromRoomId, c.toRoomId])]));
  const roomRows = await prisma.room.findMany({
    where: { id: { in: involvedIds } },
    include: { roomType: true },
  });
  const roomById = new Map(roomRows.map((r) => [r.id, r]));
  const bedTypeOf = (id: string | null) =>
    id ? ((roomById.get(id) as { bedType?: string | null } | undefined)?.bedType ?? null) : null;

  // Bed setup AT SELECTION TIME: the earliest ROOM.BED_TYPE_CHANGED trace after the selection
  // records the value it moved FROM; no trace since then means the registry still holds it.
  const bedCutoff = initialSelectedAt ?? entry.createdAt;
  const bedTraces = initialRoomIds.length
    ? await prisma.traceEvent.findMany({
        where: {
          eventType: "ROOM.BED_TYPE_CHANGED",
          entityType: "Room",
          entityId: { in: initialRoomIds },
          timestamp: { gte: bedCutoff },
        },
        orderBy: { timestamp: "asc" },
        select: { entityId: true, payload: true },
      })
    : [];
  const initialBedByRoom = new Map<string, string | null>();
  for (const t of bedTraces) {
    if (initialBedByRoom.has(t.entityId)) continue;
    const from = (t.payload as { from?: unknown } | null)?.from;
    initialBedByRoom.set(t.entityId, typeof from === "string" ? from : null);
  }

  const rooms: RoomPlanHistoryItem[] = currentRoomIds.map((currentRoomId) => {
    const current = roomById.get(currentRoomId);
    const initialRoomId = originOf.get(currentRoomId) ?? null;
    const initial = initialRoomId ? roomById.get(initialRoomId) : undefined;
    const initialBedType = initialRoomId
      ? (initialBedByRoom.get(initialRoomId) ?? bedTypeOf(initialRoomId))
      : null;
    const currentBedType = bedTypeOf(currentRoomId);
    const roomChanged = initialRoomId != null && initialRoomId !== currentRoomId;
    return {
      currentRoomId,
      currentRoomNumber: current?.roomNumber ?? null,
      currentRoomTypeName: current?.roomType?.name ?? null,
      currentBedType,
      initialRoomId,
      initialRoomNumber: initial?.roomNumber ?? null,
      initialRoomTypeName: initial?.roomType?.name ?? null,
      initialBedType,
      roomChanged,
      bedTypeChanged: !roomChanged && initialBedType != null && currentBedType != null && initialBedType !== currentBedType,
      changes: chain
        .filter((c) => (originOf.get(c.toRoomId) ?? c.fromRoomId) === (initialRoomId ?? currentRoomId))
        .map((c) => ({
          fromRoomNumber: roomById.get(c.fromRoomId)?.roomNumber ?? null,
          toRoomNumber: roomById.get(c.toRoomId)?.roomNumber ?? null,
          at: c.at.toISOString(),
          reason: c.reason,
        })),
    };
  });

  return {
    entryId,
    initialSelectedAt: initialSelectedAt ? initialSelectedAt.toISOString() : null,
    rooms,
  };
}

export type RoomChangeOutcome = {
  entryId: string;
  originStage: string;
  newSegmentNumber: number;
  fromRoom: { roomId: string; roomNumber: string; roomTypeName: string | null };
  /** The primary replacement (the new room covering the most nights). */
  toRoom: { roomId: string; roomNumber: string; roomTypeName: string | null };
  /**
   * Every NEW room of the change with the nights it covers (2026-08-14, per-night form — the
   * simple swap reports exactly one). The from-room's kept nights are NOT listed here.
   */
  toRooms: Array<{ roomId: string; roomNumber: string; roomTypeName: string | null; nights: string[] }>;
  /**
   * True when the change moved nothing — a SETUP-ONLY change on the from-room (2026-08-19):
   * extra beds / meals / rates re-priced on the same room (`toRoom` === `fromRoom`,
   * `toRooms` empty).
   */
  setupOnly: boolean;
  /** True when a FULL composition table was the basis (2026-08-19), not a field patch. */
  repriced: boolean;
  /** True when the re-price moved a negotiated rate, a waiver or the discount. */
  commercialTermsChanged: boolean;
  /** Nights the guest KEEPS the from-room for (per-night form; empty on a full swap). */
  keptNights: string[];
  sameType: boolean;
  /** Nights the substitution covered (S7: from tonight; slept nights stay on the old room). */
  substitutionNights: string[];
  pricing: {
    priorTotal: number | null;
    newTotal: number | null;
    delta: number | null;
    currency: string | null;
  };
  quotationId: string | null;
  /**
   * The primary new room's bed setup as recorded in the registry after the change, when the
   * operator asked for one (2026-08-14) — null when no bed setup was requested. Best-effort:
   * if the registry write failed the requested value is still reported so the desk can retry
   * via the bed-type dropdown.
   */
  appliedBedType: string | null;
  /** Bed setups recorded per new room (per-night form; superset of appliedBedType). */
  appliedBedTypes: Array<{ roomId: string; roomNumber: string; bedType: string }>;
  walk: {
    returnedToOrigin: boolean;
    reachedStage: string;
    blocked: { atStep: string; code: string | null; message: string } | null;
  };
};

/**
 * Optional setup adjustments for the NEW room, applied to the carried composition row before
 * the silent quote prices it (2026-08-14, operator request — the change panel is a mini
 * booking flow: room, then meals / extra bed / bed setup, all from the current stage).
 * Everything omitted carries unchanged. Validated BEFORE the irreversible re-entry.
 */
export type RoomChangeAdjustments = {
  /** Physical bed setup for the new room — must be achievable from its own bed stock. */
  bedType?: string;
  extraBedCount?: number;
  mealPlanCpCount?: number;
  mealPlanMaplCount?: number;
  mealPlanMapdCount?: number;
  mealPlanApCount?: number;
};

export async function changeRoomToNewSegment(
  prisma: PrismaClient,
  actor: Actor,
  input: {
    entryId: string;
    fromRoomId: string;
    /** Single replacement room for every substitution night (the simple swap). */
    toRoomId?: string;
    /**
     * Per-night replacement, S1-table style (2026-08-14, operator request): one room per
     * substitution night — different rooms on different nights, or the FROM room itself on
     * nights the guest keeps. Must cover exactly the substitution nights.
     */
    perNight?: Array<{ date: string; roomId: string }>;
    reason: string;
    /**
     * Setup for the single replacement room (simple-swap sugar — applied to the primary) — OR,
     * with NO `toRoomId`/`perNight` at all (2026-08-19, operator request: "put the extra bed
     * selection option on S5–S7"), a SETUP-ONLY change on the from-room itself: the guest keeps
     * the room, only its extra beds / meals change, and the booking still walks the whole
     * governed journey (new segment, silent re-price, back to this stage) because the frozen
     * terms are what's changing. In-house (S7) the new setup applies from TONIGHT: the slept
     * nights keep the old count on the same composition row via per-night overrides, and the
     * assignment row splits exactly like a mid-stay room change, so the ledger and the stay
     * total both read the change from the right night.
     */
    adjustments?: RoomChangeAdjustments;
    /** Per-room setups for the per-night form — one entry per distinct NEW room. */
    roomSetups?: Array<RoomChangeAdjustments & { roomId: string }>;
    /**
     * FULL re-price basis (2026-08-19, operator request — "make the table exactly the one in
     * S2, with rate negotiation and the discount"): the S2 negotiation table's own emission,
     * one row per room of the plan, replacing the carried compositions outright instead of
     * patching them field by field like `adjustments`. Combines with a room change (the rows
     * then describe the plan AFTER the substitution) or stands alone as a pure re-price.
     *
     * Rooms must match the resulting plan exactly — adding or removing a room is a room
     * change, which has its own form. Validated against the SAME guards the quote runs,
     * before the irreversible re-entry.
     */
    roomCompositions?: RoomCompositionServiceInput[];
    /**
     * The booking-wide discount to price with. `undefined` carries the prior quote's forward
     * (every existing caller); an explicit `null` clears it. When it changes, the ACTING
     * operator's authority band is what the discount is measured against — carrying the prior
     * approval would let a lower level raise a concession someone else sanctioned.
     */
    requestedDiscount?: { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
  },
): Promise<RoomChangeOutcome> {
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("reason is required");
  if (!input.fromRoomId?.trim()) throw new ValidationError("fromRoomId is required");
  const hasPerNightForm = Array.isArray(input.perNight) && input.perNight.length > 0;
  const hasSetup =
    !!input.adjustments && Object.values(input.adjustments).some((v) => v !== undefined && v !== null);
  // Naming the from-room itself as the single target is the same ask as naming no target.
  const hasSingle = !!input.toRoomId?.trim() && input.toRoomId!.trim() !== input.fromRoomId.trim();
  if (hasSingle && hasPerNightForm) {
    throw new ValidationError("Provide either toRoomId (one room for every night) or perNight (a room per night) — not both");
  }
  const setupOnly = !hasSingle && !hasPerNightForm;
  // A full re-price basis counts as "something to do" on its own — it IS the change.
  const hasReprice = Array.isArray(input.roomCompositions) && input.roomCompositions.length > 0;
  const hasDiscountEdit = input.requestedDiscount !== undefined;
  if (setupOnly && !hasSetup && !hasReprice && !hasDiscountEdit) {
    throw new ValidationError(
      input.toRoomId?.trim()
        ? "The replacement room is the same room — to change only its setup, send adjustments (extra beds / meals) or roomCompositions"
        : "Provide toRoomId (one room for every night), perNight (a room per night), or roomCompositions / adjustments alone to re-price this booking in place",
    );
  }
  if (setupOnly && input.roomSetups?.length) {
    throw new ValidationError("roomSetups is for per-night room changes — a setup-only change takes `adjustments` or `roomCompositions`");
  }
  if (hasReprice) {
    // Two ways to say the same thing, applied in sequence, would make the result depend on
    // ordering — so a composition table admits no composition patches on top. `bedType` is the
    // exception BY CONSTRUCTION: it is a room-registry fact (how the beds are physically
    // arranged), not a composition field, so it cannot collide with anything in the table and
    // still rides along with it.
    const compositionPatch = (a?: RoomChangeAdjustments) =>
      !!a && Object.entries(a).some(([k, v]) => k !== "bedType" && v != null);
    if (compositionPatch(input.adjustments) || (input.roomSetups ?? []).some(compositionPatch)) {
      throw new ValidationError(
        "roomCompositions is the full basis — send it alone (bed setup aside), without adjustments / roomSetups, which patch the carried composition instead",
      );
    }
  }
  if (hasDiscountEdit && !hasReprice && input.requestedDiscount != null) {
    // A discount edit rides with the table that produced it; the figures it applies to must be
    // the ones on screen, not whatever the prior quote happened to hold.
    throw new ValidationError("A discount change is sent with the composition table it was negotiated on (roomCompositions)");
  }

  const ctx = await loadRoomChangeContext(prisma, input.entryId, input.fromRoomId);
  const { entry, stage } = ctx;

  // ── The night → room map the change asks for ───────────────────────────────────────────────
  const targetsByNight = new Map<string, string>();
  if (setupOnly) {
    // The guest keeps the room on every night — nothing moves, only the setup re-prices.
    for (const d of ctx.substitutionNights) targetsByNight.set(d, input.fromRoomId);
  } else if (hasSingle) {
    for (const d of ctx.substitutionNights) targetsByNight.set(d, input.toRoomId!.trim());
  } else {
    for (const n of input.perNight!) {
      const date = String(n.date).slice(0, 10);
      if (!n.roomId?.trim()) throw new ValidationError(`perNight: roomId missing for ${date}`);
      if (targetsByNight.has(date)) throw new ValidationError(`perNight lists ${date} twice`);
      targetsByNight.set(date, n.roomId.trim());
    }
    const missing = ctx.substitutionNights.filter((d) => !targetsByNight.has(d));
    const extras = [...targetsByNight.keys()].filter((d) => !ctx.substitutionNights.includes(d));
    if (missing.length > 0) throw new ValidationError(`perNight must cover every night of the change — missing ${missing.join(", ")}`);
    if (extras.length > 0) throw new ValidationError(`perNight includes nights outside the change: ${extras.join(", ")}`);
  }

  // Distinct NEW rooms (the from-room may appear per-night: those nights the guest KEEPS).
  const distinctTargets = Array.from(new Set(targetsByNight.values())).filter((id) => id !== input.fromRoomId);
  const keptFromNights = [...targetsByNight.entries()].filter(([, id]) => id === input.fromRoomId).map(([d]) => d).sort();
  if (!setupOnly && distinctTargets.length === 0) {
    throw new ValidationError("Every night keeps the current room — nothing changes");
  }
  if (!setupOnly && stage === Stage.S7 && (distinctTargets.length > 1 || keptFromNights.length > 0)) {
    // In-house the guest physically moves ONCE — a per-night split of the remaining nights
    // would schedule future moves nothing executes. Change again on the day of the next move.
    throw new ValidationError(
      "In-house (Stay) the guest moves once, to one room for all remaining nights — to use different rooms on later nights, run another room change on the day of that move",
    );
  }

  const targetRooms = await prisma.room.findMany({ where: { id: { in: distinctTargets } }, include: { roomType: true } });
  const targetById = new Map(targetRooms.map((r) => [r.id, r]));
  // A setup-only change's "target" is the from-room itself — the setup validation below reads
  // the room's type (max extra beds) and bed stock off this map.
  if (setupOnly) targetById.set(ctx.fromRoom.id, ctx.fromRoom);
  for (const id of distinctTargets) {
    const room = targetById.get(id);
    if (!room) throw new NotFoundError("Room");
    if (room.isShadowInventory) throw new ValidationError(`Room ${room.roomNumber} is shadow inventory and cannot be booked`);
  }

  // Nights each NEW room covers (may be non-contiguous — folded to ranges for the date checks).
  const nightsByTarget = new Map<string, string[]>();
  for (const [date, roomId] of targetsByNight) {
    if (roomId === input.fromRoomId) continue;
    nightsByTarget.set(roomId, [...(nightsByTarget.get(roomId) ?? []), date]);
  }
  for (const nights of nightsByTarget.values()) nights.sort();

  for (const id of distinctTargets) {
    if (!ctx.claimedRoomIds.has(id)) continue;
    const room = targetById.get(id)!;
    // At S7 a moved-out room keeps its slept-night claim (the split end-dates its assignment,
    // it never leaves the plan), so "already part of this booking" would be misleading — name
    // the real limit: returning to a room this stay already slept in would give the room two
    // composition rows and double-price its nights, so it is not supported mid-stay.
    const toRoomNights = ctx.picture.filter((n) => n.roomIds.includes(id)).map((n) => n.date);
    const onlyPastNights = toRoomNights.length > 0 && toRoomNights.every((d) => d < ctx.todayIso);
    throw new ValidationError(
      stage === Stage.S7 && onlyPastNights
        ? `Room ${room.roomNumber} already held this booking's earlier nights this stay — moving back into a moved-out room isn't supported mid-stay; pick a different room`
        : `Room ${room.roomNumber} is already part of this booking — pick rooms outside the current plan`,
    );
  }

  // The PRIMARY replacement — the new room covering the most nights. It anchors everything
  // that is single-valued downstream (S7 physical swap, traces, the sealed-config marker,
  // the outcome's headline toRoom).
  const primaryEntry = [...nightsByTarget.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? null;
  // Setup-only: the "to" room IS the from-room — everything single-valued downstream (the S7
  // assignment split, traces, the hold anchor, the outcome) points at the room being re-set-up.
  const toRoomId = setupOnly ? input.fromRoomId : primaryEntry![0];
  const toRoom = targetById.get(toRoomId)!;
  /** "201" on a simple swap; "201 + 305" on a per-night split — for notes and traces. */
  const targetsLabel = setupOnly
    ? `${ctx.fromRoom.roomNumber} (${hasReprice ? "re-price" : "setup change"})`
    : distinctTargets.map((id) => targetById.get(id)!.roomNumber).join(" + ");

  // Authority follows WHAT the change does, not the stage (2026-08-13 ruling): a same-type
  // swap is desk logistics (L1+); a cross-type move is an upgrade/downgrade that re-prices
  // the stay, so it needs FOM+ (L2+). Per-night: EVERY new room must be same-type to count
  // as a same-type change.
  const sameType = distinctTargets.every((id) => targetById.get(id)!.roomTypeId === ctx.fromRoom.roomTypeId);
  enforceRoomChangeAuthorityForStage({ currentStage: String(stage), actorLevel: actor.actorLevel, sameType });

  // ── Availability, validated the way S1 validates it (recall-plus-revalidate doctrine) ──────
  // Each NEW room is checked over ITS OWN nights only — a room taking one night of three must
  // not be refused for a conflict on a night someone else covers.
  for (const [roomId, nights] of nightsByTarget) {
    const room = targetById.get(roomId)!;
    for (const range of foldIsoNightsToRanges(nights)) {
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
        excludeEntryId: input.entryId,
      });
      enforceNoOverlappingBookingForCommittedHold({
        conflicts: conflicts.map((c) => ({ ...c, roomNumber: room.roomNumber })),
      });
    }
  }
  // The guest moves NOW at S6/S7 into the room covering the first night; a room that only
  // starts on a later night needs to be ready by that night, not this minute.
  if (stage === Stage.S6 || stage === Stage.S7) {
    const firstNight = ctx.substitutionNights[0];
    for (const [roomId, nights] of nightsByTarget) {
      const room = targetById.get(roomId)!;
      enforceRoomPhysicallyAssignableForS5({
        physicalState: room.physicalState,
        expectedReadyAt: room.expectedReadyAt,
        arrival: nights[0] === firstNight ? new Date() : new Date(`${nights[0]}T00:00:00.000Z`),
      });
    }
  }

  // ── The commercial basis being carried: operative quotation of the CURRENT segment ─────────
  // segments are loaded newest-first (segmentNumber desc) — [0] is the current one. Reading the
  // other end silently carried SEGMENT 1's compositions into every later change (verified live:
  // a second swap resurrected the room the first swap had removed).
  const currentSegment = entry.segments[0];
  if (!currentSegment) throw new ValidationError("Entry has no segment");
  const operative = resolveOperativeQuotation(entry.quotations, currentSegment.id)
    ?? entry.quotations.find((q) => q.state === "ACCEPTED")
    ?? null;
  // Post-freeze fallback (2026-08-19): W15 keeps the validity clock ticking after the freeze,
  // so a confirmed booking's quote routinely reads EXPIRED and `resolveOperativeQuotation`
  // rightly refuses it — but the booking is still PRICED, on the reservation's frozen terms.
  // Without this the carried compositions came back null on any such booking: a room change
  // silently dropped every room's composition (re-quoting the stay flat), and the re-price
  // path could not tell what had changed. Same reasoning as the billing summary's fallback —
  // an expired clock must not un-price committed money.
  const frozenTerms = (entry.reservation?.frozenCommercialTerms ?? null) as Record<string, unknown> | null;
  const operativeTerms = (operative?.commercialTerms ?? null) as Record<string, unknown> | null;
  const priorTerms =
    Array.isArray(operativeTerms?.roomCompositions) && operativeTerms!.roomCompositions.length > 0
      ? operativeTerms
      : Array.isArray(frozenTerms?.roomCompositions) && frozenTerms!.roomCompositions.length > 0
        ? frozenTerms
        : operativeTerms ?? frozenTerms;
  const priorCompositions = Array.isArray(priorTerms?.roomCompositions)
    ? (priorTerms!.roomCompositions as RoomCompositionServiceInput[])
    : null;
  const frozenTotal = (() => {
    const t = (frozenTerms?.compositionTotals ?? null) as { total?: unknown } | null;
    return typeof t?.total === "number" && Number.isFinite(t.total) ? t.total : null;
  })();
  const priorTotal = operative?.totalAmount != null ? Number(operative.totalAmount) : frozenTotal;

  // Capacity: the party moving rooms must fit EVERY room it will sleep in. Chargeable
  // occupants only — under-11s share bedding and take no slot (mirrors
  // computeChargeableOccupants; composition rows classify 11+ as adults) — against
  // `maxCapacity`, the with-extra-bed ceiling. NOTE (2026-08-14): this read
  // `roomType.maxOccupancy` before, a TS field that ceased to exist in the 2026-07-10 rename
  // to standardCapacity/maxCapacity — the check had been silently dead.
  const movingComposition = priorCompositions?.find((c) => c.roomId === input.fromRoomId) ?? null;
  const movingChargeable = movingComposition?.adultCount ?? movingComposition?.occupantCount ?? null;
  for (const id of distinctTargets) {
    const room = targetById.get(id)!;
    const maxCapacity = (room.roomType as { maxCapacity?: number } | null)?.maxCapacity ?? null;
    if (movingChargeable != null && maxCapacity != null && movingChargeable > maxCapacity) {
      throw new ValidationError(
        `Room ${room.roomNumber} (${room.roomType?.name ?? "its type"}) sleeps at most ${maxCapacity} chargeable guests — the ${movingChargeable} in Room ${ctx.fromRoom.roomNumber} do not fit`,
      );
    }
  }

  // ── The substituted room plan ───────────────────────────────────────────────────────────────
  const substitutedPicture = ctx.picture.map((n) => ({
    date: n.date,
    roomIds: n.roomIds.map((id) => (id === input.fromRoomId && targetsByNight.has(n.date) ? targetsByNight.get(n.date)! : id)),
  }));
  const substitutedDistinct = Array.from(new Set(substitutedPicture.flatMap((n) => n.roomIds)));
  const priorSel = readOptionSelected(ctx.sealedConfig?.optionSelected ?? null);
  // S7 always needs the per-night shape (the split IS per-night), and so does any per-night
  // selection (several new rooms / kept nights can't be said in the whole-stay shape);
  // pre-occupancy single swaps keep the original shape family so downstream displays don't
  // change form.
  // A setup-only change moves nothing, so the plan keeps whatever shape it already had.
  const emitPerNight = setupOnly
    ? !!priorSel.perNight
    : stage === Stage.S7 || !!priorSel.perNight || distinctTargets.length > 1 || keptFromNights.length > 0;
  const deficientById = new Map<string, boolean>();
  {
    const involved = await prisma.room.findMany({
      where: { id: { in: substitutedDistinct } },
      select: { id: true, isDeficient: true },
    });
    for (const r of involved) deficientById.set(r.id, r.isDeficient === true);
  }
  const anyDeficient = substitutedDistinct.some((id) => deficientById.get(id) === true);
  // Marker: toRoomId stays the PRIMARY new room (the plan-history chain folds 1:1 markers);
  // toRoomIds carries the full per-night set for future consumers.
  // A setup-only change writes NO roomChange marker — the plan-history chain folds markers
  // room → room, and a 205 → 205 link would print a spurious "Changed" on the Initially cell.
  // The sealed config's searchCriteria carries a `setupChange` note instead.
  const roomChangeMarker = setupOnly ? null : { fromRoomId: input.fromRoomId, toRoomId, toRoomIds: distinctTargets };
  const substitutedOption = emitPerNight
    ? {
        perNight: substitutedPicture.map((n) => ({
          date: n.date,
          roomIds: n.roomIds.map((roomId) => ({ roomId, isDeficient: deficientById.get(roomId) === true })),
        })),
        isDeficient: anyDeficient,
        ...(roomChangeMarker ? { roomChange: roomChangeMarker } : {}),
      }
    : {
        roomIds: substitutedDistinct.map((roomId) => ({ roomId, isDeficient: deficientById.get(roomId) === true })),
        isDeficient: anyDeficient,
        ...(roomChangeMarker ? { roomChange: roomChangeMarker } : {}),
      };

  // ── The carried compositions, with the one room substituted ────────────────────────────────
  let newCompositions: RoomCompositionServiceInput[] | undefined;
  if (priorCompositions && priorCompositions.length > 0) {
    if (setupOnly) {
      // Nothing moves — every row carries; the setup block below rewrites the one row.
      newCompositions = priorCompositions.map((c) => ({ ...c, nightMealOverrides: [...(c.nightMealOverrides ?? [])] }));
    } else if (stage === Stage.S7 && movingComposition) {
      // In-house split: the old room keeps its row (it now prices only its slept nights via the
      // per-room nights fix), and the new room gets a copy for the remaining nights. Per-night
      // meal overrides follow their dates.
      const oldOverrides = (movingComposition.nightMealOverrides ?? []).filter((o) => String(o.date).slice(0, 10) < ctx.todayIso);
      const newOverrides = (movingComposition.nightMealOverrides ?? []).filter((o) => String(o.date).slice(0, 10) >= ctx.todayIso);
      newCompositions = [
        ...priorCompositions.map((c) =>
          c.roomId === input.fromRoomId ? { ...c, nightMealOverrides: oldOverrides } : { ...c },
        ),
        {
          ...movingComposition,
          roomId: toRoomId,
          nightMealOverrides: newOverrides,
          // A negotiated rate was negotiated for the OLD room's type — a cross-type move prices
          // at the new type's own resolved rate instead. Same-type keeps the negotiation.
          ...(sameType ? {} : { negotiatedRoomRate: undefined }),
        },
      ];
    } else if (movingComposition) {
      // Pre-occupancy, generalized for the per-night form (2026-08-14): one row per room now
      // carrying the moving party — each NEW room, plus the from-room itself when some nights
      // are kept — with per-night meal overrides following the nights that room actually
      // covers. The same guests appear on each row deliberately (sequential rooms, one party —
      // the S7 split's precedent); pricing is per-room nights so nothing double-charges.
      const carryRooms: Array<{ roomId: string; nights: string[] }> = [
        ...(keptFromNights.length > 0 ? [{ roomId: input.fromRoomId, nights: keptFromNights }] : []),
        ...[...nightsByTarget.entries()].map(([roomId, nights]) => ({ roomId, nights })),
      ];
      const spawned = carryRooms.map(({ roomId, nights }) => {
        const room = targetById.get(roomId);
        const crossType = roomId !== input.fromRoomId && room != null && room.roomTypeId !== ctx.fromRoom.roomTypeId;
        return {
          ...movingComposition,
          roomId,
          nightMealOverrides: (movingComposition.nightMealOverrides ?? []).filter((o) =>
            nights.includes(String(o.date).slice(0, 10)),
          ),
          ...(crossType ? { negotiatedRoomRate: undefined } : {}),
        };
      });
      newCompositions = [...priorCompositions.filter((c) => c.roomId !== input.fromRoomId).map((c) => ({ ...c })), ...spawned];
    } else {
      newCompositions = priorCompositions.map((c) => ({ ...c }));
    }

    // Reconcile against the substituted plan — the frozen terms must describe the rooms the
    // booking actually holds. A stray row (references a room not in the plan) is re-pointed at
    // a plan room that lacks one (its guest data most likely belongs there — the stray is the
    // pre-drift identity), and anything still stray after pairing is dropped. No-op when the
    // compositions already match the plan, which is every normal case.
    const planSet = new Set(substitutedDistinct);
    const compRoomSet = new Set(newCompositions.map((c) => c.roomId));
    const strayRows = newCompositions.filter((c) => !planSet.has(c.roomId));
    const missingRooms = substitutedDistinct.filter((id) => !compRoomSet.has(id));
    for (let i = 0; i < missingRooms.length && i < strayRows.length; i++) {
      strayRows[i].roomId = missingRooms[i];
    }
    newCompositions = newCompositions.filter((c) => planSet.has(c.roomId));
  }

  // ── Full re-price basis (2026-08-19) ───────────────────────────────────────────────────────
  // The S2 negotiation table's own emission REPLACES the carried compositions. Everything is
  // checked here, before the irreversible re-entry: the rows must describe exactly the rooms
  // the plan will hold, and they must pass the same guards the quote itself applies.
  let commercialChanged = false;
  if (hasReprice) {
    const supplied = input.roomCompositions!;
    const planSet = new Set(substitutedDistinct);
    const suppliedIds = supplied.map((c) => c.roomId);
    const dupes = suppliedIds.filter((id, i) => suppliedIds.indexOf(id) !== i);
    if (dupes.length > 0) throw new ValidationError("roomCompositions lists the same room twice");
    const roomRows = await prisma.room.findMany({
      where: { id: { in: [...new Set([...suppliedIds, ...substitutedDistinct])] } },
      select: { id: true, roomNumber: true },
    });
    const numberByRoomId = new Map(roomRows.map((r) => [r.id, r.roomNumber]));
    const label = (id: string) => `Room ${numberByRoomId.get(id) ?? id.slice(0, 6)}`;
    const strays = suppliedIds.filter((id) => !planSet.has(id));
    const missing = substitutedDistinct.filter((id) => !suppliedIds.includes(id));
    if (strays.length > 0 || missing.length > 0) {
      throw new ValidationError(
        `roomCompositions must cover exactly the booking's rooms — ${
          [
            strays.length > 0 ? `${strays.map(label).join(", ")} ${strays.length === 1 ? "is" : "are"} not part of the plan` : null,
            missing.length > 0 ? `${missing.map(label).join(", ")} ${missing.length === 1 ? "is" : "are"} missing` : null,
          ].filter(Boolean).join("; ")
        }. Adding or removing a room is a room change, not a re-price.`,
      );
    }

    // Commercial vs operational (see p58's `enforceRepriceAuthorityForStage`): a negotiated
    // rate, a waiver or the discount moving makes this a rate revision. Compared against the
    // operative quotation this booking is priced on today, per room.
    // The baseline is what the CARRY would have produced — `newCompositions` as the block above
    // just computed it, not the pre-change plan. That is what makes the comparison correct for
    // every form: a pure re-price (carry === prior), a room change (the from-room's row remapped
    // onto the new room, with `negotiatedRoomRate` already dropped on a cross-type move because
    // that rate was negotiated for the OLD type), and a per-night split (one carried row per
    // carrying room). Comparing against the pre-change plan instead would read a new room's
    // CARRIED rate as a fresh negotiation and demand FOM authority for an L1 same-type swap.
    const priorByRoom = new Map((newCompositions ?? priorCompositions ?? []).map((c) => [c.roomId, c]));
    const money = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Number(v.toFixed(2)) : null);
    const COMMERCIAL_RATES = [
      "negotiatedRoomRate",
      "negotiatedExtraBedRate",
      "negotiatedBreakfastRate",
      "negotiatedLunchRate",
      "negotiatedDinnerRate",
    ] as const;
    for (const c of supplied) {
      const prior = priorByRoom.get(c.roomId) ?? null;
      // A room that had no prior row (the target of a room change) is priced at its own type's
      // published rate — carrying no negotiation. Only an explicit rate on it is commercial.
      for (const k of COMMERCIAL_RATES) {
        if (money(c[k]) !== money(prior?.[k])) commercialChanged = true;
      }
      if ((c.isFoc ?? false) !== (prior?.isFoc ?? false)) commercialChanged = true;
      if ((c.serviceChargeApplies ?? true) !== (prior?.serviceChargeApplies ?? true)) commercialChanged = true;
      if ((c.gstApplies ?? true) !== (prior?.gstApplies ?? true)) commercialChanged = true;
    }
    if (hasDiscountEdit) {
      const before = (priorTerms?.requestedDiscount ?? null) as { discountPercent?: number; discountAmount?: number } | null;
      const after = input.requestedDiscount ?? null;
      if (money(before?.discountPercent) !== money(after?.discountPercent) || money(before?.discountAmount) !== money(after?.discountAmount)) {
        commercialChanged = true;
      }
    }
    enforceRepriceAuthorityForStage({
      currentStage: String(stage),
      actorLevel: actor.actorLevel,
      touchesCommercialTerms: commercialChanged,
    });

    // The same three guards the quote runs — failing here leaves the booking untouched.
    enforceRoomCompositionsPriceable(supplied, {
      numberByRoomId,
      stayCheckIn: ctx.checkIn,
      stayCheckOut: ctx.checkOut,
      nights: ctx.nightsIso.length,
    });

    // A pure re-price that changes nothing must not roll a segment (the operator opened the
    // table, looked, and saved). Only checked when no room moved — a room change is itself
    // the change. Compares every field the quote actually prices on.
    if (setupOnly && !commercialChanged) {
      const PRICED_FIELDS = [
        "occupantCount", "adultCount", "cnb6To10Count", "cnbUnder6Count", "extraBedCount",
        "mealPlanCpCount", "mealPlanMaplCount", "mealPlanMapdCount", "mealPlanApCount",
        "mealPlanOthersCount", "othersBreakfastPax", "othersLunchPax", "othersDinnerPax",
      ] as const;
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      const nightsKey = (c: RoomCompositionServiceInput) =>
        JSON.stringify(
          (c.nightMealOverrides ?? [])
            .map((o) => ({ ...o, date: String(o.date).slice(0, 10) }))
            .sort((a, b) => a.date.localeCompare(b.date)),
        );
      const identical = supplied.every((c) => {
        const prior = priorByRoom.get(c.roomId);
        if (!prior) return false;
        return PRICED_FIELDS.every((k) => n(c[k]) === n(prior[k])) && nightsKey(c) === nightsKey(prior);
      });
      if (identical) {
        throw new ValidationError("Nothing on the table changed — edit a figure before re-pricing, or close the panel");
      }
    }
    newCompositions = supplied.map((c) => ({ ...c }));

    // In-house: the table describes the stay FROM TONIGHT. Pin each room's slept nights to what
    // they actually were, so re-pricing does not retroactively re-charge nights the folio has
    // already posted. Only meals and extra beds can be expressed per night — a mid-stay RATE
    // change cannot, which is why it is a GM decision and why the desk says the already-posted
    // nights need a folio correction rather than being silently re-billed.
    if (setupOnly && stage === Stage.S7) {
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      for (const row of newCompositions) {
        const prior = priorByRoom.get(row.roomId) ?? null;
        if (!prior) continue;
        const mealsChanged =
          n(row.mealPlanCpCount) !== n(prior.mealPlanCpCount) ||
          n(row.mealPlanMaplCount) !== n(prior.mealPlanMaplCount) ||
          n(row.mealPlanMapdCount) !== n(prior.mealPlanMapdCount) ||
          n(row.mealPlanApCount) !== n(prior.mealPlanApCount) ||
          n(row.mealPlanOthersCount) !== n(prior.mealPlanOthersCount) ||
          n(row.othersBreakfastPax) !== n(prior.othersBreakfastPax) ||
          n(row.othersLunchPax) !== n(prior.othersLunchPax) ||
          n(row.othersDinnerPax) !== n(prior.othersDinnerPax);
        const bedsChanged = n(row.extraBedCount) !== n(prior.extraBedCount);
        pinSleptNightsToPriorSetup(
          row,
          { composition: prior, mealsChanged, bedsChanged },
          ctx.picture.filter((x) => x.roomIds.includes(row.roomId) && x.date < ctx.todayIso).map((x) => x.date),
        );
      }
    }
  }

  // ── Operator setups per new room (2026-08-14) ──────────────────────────────────────────────
  // Meals / extra bed rewrite each carried composition row so the SILENT QUOTE prices what the
  // guest actually asked for; the bed setup is a registry fact applied once the change is real.
  // All of it is validated HERE — before the irreversible re-entry — so a bad ask refuses
  // cleanly instead of stranding the booking mid-walk. `adjustments` (simple-swap sugar)
  // applies to the primary room; `roomSetups` carries one entry per new room.
  const setupByRoom = new Map<string, RoomChangeAdjustments>();
  if (input.adjustments) setupByRoom.set(toRoomId, input.adjustments);
  for (const s of input.roomSetups ?? []) {
    const { roomId, ...rest } = s;
    if (!nightsByTarget.has(roomId)) {
      throw new ValidationError("roomSetups references a room that is not one of the change's new rooms");
    }
    setupByRoom.set(roomId, { ...(setupByRoom.get(roomId) ?? {}), ...rest });
  }
  const requestedBedTypes = new Map<string, string>();
  for (const [roomId, adj] of setupByRoom) {
    const room = targetById.get(roomId)!;
    const mealFields = [adj.mealPlanCpCount, adj.mealPlanMaplCount, adj.mealPlanMapdCount, adj.mealPlanApCount];
    const wantsMealChange = mealFields.some((v) => v != null);
    const wantsCompositionChange = wantsMealChange || adj.extraBedCount != null;
    if (adj.bedType != null) {
      const bedType = String(adj.bedType).trim().toUpperCase();
      if (!ROOM_BED_TYPES.includes(bedType as RoomBedType)) {
        throw new ValidationError(`bedType must be one of: ${ROOM_BED_TYPES.join(", ")}`);
      }
      const achievable = bedTypeConversionGroup((room as { bedType?: string | null }).bedType);
      if (achievable.length > 0 && !achievable.includes(bedType)) {
        throw new ValidationError(
          `Room ${room.roomNumber}'s beds can be set up as ${achievable.join(" or ")} — not ${bedType}`,
        );
      }
      requestedBedTypes.set(roomId, bedType);
    }
    if (!wantsCompositionChange) {
      // A bed setup riding alongside a composition table is legitimate (see the guard above) —
      // the table is the change; this just records how the beds are arranged.
      if (setupOnly && !hasReprice) {
        // A bed-type-only ask is a registry fact, not a commercial one — no segment to roll.
        throw new ValidationError(
          "Only the bed setup was asked for — change that with the bed-setup dropdown on the room row; a setup-only change re-prices extra beds / meals",
        );
      }
      continue;
    }
    for (const v of [adj.extraBedCount, ...mealFields]) {
      if (v != null && (!Number.isInteger(v) || v < 0)) {
        throw new ValidationError("Extra-bed and meal-plan counts must be whole numbers of 0 or more");
      }
    }
    const row = newCompositions?.find((c) => c.roomId === roomId) ?? null;
    if (!row) {
      throw new ValidationError(
        "This booking has no per-room composition recorded — meals and extra beds can only be adjusted through a fresh quote, not during the room change",
      );
    }
    const maxExtraBeds = (room.roomType as { maxExtraBeds?: number } | null)?.maxExtraBeds ?? null;
    if (adj.extraBedCount != null && maxExtraBeds != null && adj.extraBedCount > maxExtraBeds) {
      throw new ValidationError(
        `${room.roomType?.name ?? "That room type"} allows at most ${maxExtraBeds} extra bed${maxExtraBeds === 1 ? "" : "s"}`,
      );
    }
    const nextCp = adj.mealPlanCpCount ?? row.mealPlanCpCount ?? 0;
    const nextMapl = adj.mealPlanMaplCount ?? row.mealPlanMaplCount ?? 0;
    const nextMapd = adj.mealPlanMapdCount ?? row.mealPlanMapdCount ?? 0;
    const nextAp = adj.mealPlanApCount ?? row.mealPlanApCount ?? 0;
    const occ =
      row.occupantCount ?? ((row.adultCount ?? 0) + (row.cnb6To10Count ?? 0) + (row.cnbUnder6Count ?? 0) || null);
    const planSum = nextCp + nextMapl + nextMapd + nextAp + (row.mealPlanOthersCount ?? 0);
    if (wantsMealChange && occ != null && planSum > occ) {
      throw new ValidationError(
        `Meal plans cover ${planSum} guests but only ${occ} sleep in Room ${room.roomNumber} — reduce the counts`,
      );
    }
    // What the row said BEFORE the rewrite — a setup-only change compares against it (a no-op
    // must not roll a segment) and, in-house, keeps it on the slept nights.
    const priorBeds = row.extraBedCount ?? 0;
    const priorMeals = {
      mealPlanCpCount: row.mealPlanCpCount ?? 0,
      mealPlanMaplCount: row.mealPlanMaplCount ?? 0,
      mealPlanMapdCount: row.mealPlanMapdCount ?? 0,
      mealPlanApCount: row.mealPlanApCount ?? 0,
      mealPlanOthersCount: row.mealPlanOthersCount ?? 0,
      othersBreakfastPax: row.othersBreakfastPax ?? 0,
      othersLunchPax: row.othersLunchPax ?? 0,
      othersDinnerPax: row.othersDinnerPax ?? 0,
    };
    const priorOverrides = [...(row.nightMealOverrides ?? [])];
    const bedsChange = adj.extraBedCount != null && adj.extraBedCount !== priorBeds;
    const mealsChange =
      wantsMealChange &&
      (nextCp !== priorMeals.mealPlanCpCount ||
        nextMapl !== priorMeals.mealPlanMaplCount ||
        nextMapd !== priorMeals.mealPlanMapdCount ||
        nextAp !== priorMeals.mealPlanApCount);
    if (setupOnly && !bedsChange && !mealsChange) {
      const bedAsk = requestedBedTypes.get(roomId);
      const bedNow = (room as { bedType?: string | null }).bedType ?? null;
      throw new ValidationError(
        bedAsk && bedAsk !== bedNow
          ? `Only the bed setup differs — change that with the bed-setup dropdown on the room row; it is a housekeeping fact and needs no re-pricing`
          : `Room ${room.roomNumber} already has ${priorBeds} extra bed${priorBeds === 1 ? "" : "s"} and the same meal plans — nothing changes`,
      );
    }
    Object.assign(row, {
      ...(adj.extraBedCount != null ? { extraBedCount: adj.extraBedCount } : {}),
      ...(wantsMealChange
        ? {
            mealPlanCpCount: nextCp,
            mealPlanMaplCount: nextMapl,
            mealPlanMapdCount: nextMapd,
            mealPlanApCount: nextAp,
            // A changed stay-wide plan supersedes the old plan's per-night exceptions — they
            // described a distribution that no longer exists.
            nightMealOverrides: [],
          }
        : {}),
    });
    // In-house setup-only change (2026-08-19): the new setup applies from TONIGHT. The room keeps
    // ONE composition row (every consumer keys by roomId), so the slept nights are pinned to the
    // OLD setup with per-night overrides — old bed count and, when the meals moved, the old
    // distribution (or that night's own prior exception). The quotation then prices slept nights
    // as they were and remaining nights as asked, and the stay total reconciles to the ledger.
    if (setupOnly && stage === Stage.S7) {
      pinSleptNightsToPriorSetup(
        row,
        {
          composition: {
            roomId,
            ...priorMeals,
            extraBedCount: priorBeds,
            nightMealOverrides: priorOverrides,
          },
          mealsChanged: mealsChange,
          bedsChanged: bedsChange,
        },
        ctx.picture.filter((n) => n.roomIds.includes(roomId) && n.date < ctx.todayIso).map((n) => n.date),
      );
    }
    // p78's auto-add (3+ adults ⇒ ≥1 extra bed) still runs at quote time and is raise-only,
    // so a too-low extra-bed ask is corrected rather than refused — matching the S2 planner.
  }

  // Carried discount: what the prior quote recorded, re-stamped under the authority that
  // already approved it (the approval carries WITH the concession — re-testing the acting
  // operator's band would let a room swap silently strip an FOM-approved discount).
  const carriedDiscount = (priorTerms?.requestedDiscount ?? null) as
    | { discountPercent?: number; discountAmount?: number; discountBasis: string }
    | null;
  // An explicit `requestedDiscount` REPLACES the carried one (null clears it); omitted carries.
  const discountEdited = hasDiscountEdit;
  const priorDiscount = discountEdited ? input.requestedDiscount ?? null : carriedDiscount;
  const priorApprovalLevel = ((priorTerms?.discountAuthority as { approvedLevel?: string } | undefined)?.approvedLevel ??
    null) as "L1" | "L2" | "L3" | "L4" | null;
  const RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
  // The carry exists so a room swap can't silently strip an FOM-approved concession. It must
  // NOT apply to a discount the operator just changed — that one is theirs, and the
  // `registry.discount.actorCeiling` band has to be measured against THEIR level (the draft
  // refuses generation above it). Same rule the S2 create/supersede routes apply.
  const effectiveLevel: "L1" | "L2" | "L3" | "L4" =
    !discountEdited && priorDiscount && priorApprovalLevel && (RANK[priorApprovalLevel] ?? 0) > (RANK[actor.actorLevel] ?? 0)
      ? priorApprovalLevel
      : actor.actorLevel;

  const hadAssignments = entry.roomAssignments.length > 0;
  const fromAssignment = entry.roomAssignments.find((a) => a.roomId === input.fromRoomId) ?? null;
  const stayCheckIn = ctx.checkIn;
  const stayCheckOut = ctx.checkOut;
  const now = new Date();
  let newAssignmentIdForS7: string | null = null;

  // ── 1. The governed re-entry (new segment at S2) with origin-specific side effects ─────────
  const reasonForTrace = hasReprice
    ? `BOOKING_REPRICE: ${reason}`
    : setupOnly
      ? `ROOM_SETUP_CHANGE: ${reason}`
      : `ROOM_CHANGE: ${reason}`;
  if (stage === Stage.S7) {
    await backflowRoomChangeToS2(prisma, input.entryId, actor, {
      reason: reasonForTrace,
      fromStage: stage,
      hooks: async (tx) => {
        // Physical swap NOW — the guest moves tonight; the paperwork walk follows (SIG-S7 §264:
        // old room OCCUPIED → DEPARTED_DIRTY, new room OCCUPIED). A setup-only change moves
        // nobody: the room stays OCCUPIED and its H2/H3 stand.
        if (!setupOnly) {
          await transitionRoomClaimState(tx, {
            roomId: input.fromRoomId,
            toState: InventoryClaimState.DEPARTED_DIRTY,
            actorId: actor.actorId,
            entryId: input.entryId,
            reason: "S7 in-place room change",
            now,
          });
          await transitionRoomClaimState(tx, {
            roomId: toRoomId,
            toState: InventoryClaimState.OCCUPIED,
            actorId: actor.actorId,
            entryId: input.entryId,
            reason: "S7 in-place room change",
            now,
          });
        }

        // Dated assignment split: the old room's row ends tonight (its frozen figures scaled to
        // the nights it actually covered, so `frozenSubtotal ÷ nights` stays the true per-night
        // rate), the new room's row runs tonight → checkout. Night audit already respects the
        // [startDate, endDate) window, so past nights stay billed on the old room and future
        // audits post to the new one. A setup-only change splits the SAME room's row the same
        // way — slept nights keep the old frozen figures, tonight onward is re-frozen from the
        // silent quote below — except when the row already starts tonight (a second change the
        // same day), where it is simply re-frozen in place.
        let reuseRowInPlace = false;
        if (fromAssignment) {
          const aStart = fromAssignment.startDate ?? stayCheckIn;
          const aEnd = fromAssignment.endDate ?? stayCheckOut;
          const totalNights = Math.max(1, Math.round((aEnd.getTime() - aStart.getTime()) / DAY_MS));
          const sleptNights = Math.max(0, Math.min(totalNights, Math.round((ctx.today.getTime() - aStart.getTime()) / DAY_MS)));
          if (setupOnly && sleptNights === 0) {
            reuseRowInPlace = true;
            newAssignmentIdForS7 = fromAssignment.id;
          } else {
            const scale = new Prisma.Decimal(sleptNights).div(totalNights);
            await tx.roomAssignment.update({
              where: { id: fromAssignment.id },
              data: {
                startDate: aStart,
                endDate: ctx.today,
                ...(fromAssignment.frozenSubtotal != null
                  ? { frozenSubtotal: new Prisma.Decimal(fromAssignment.frozenSubtotal.toString()).mul(scale) }
                  : {}),
                ...(fromAssignment.frozenTotal != null
                  ? { frozenTotal: new Prisma.Decimal(fromAssignment.frozenTotal.toString()).mul(scale) }
                  : {}),
              },
            });
          }
        }
        if (!reuseRowInPlace) {
          const newAssignmentId = await allocateReadableId(tx, "ROOM_ASSIGNMENT" as const, now);
          newAssignmentIdForS7 = newAssignmentId;
          await tx.roomAssignment.create({
            data: {
              id: newAssignmentId,
              entryId: input.entryId,
              roomId: toRoomId,
              assignedBy: actor.actorId,
              deficientAtAssignment: toRoom.isDeficient === true,
              startDate: ctx.today,
              endDate: stayCheckOut,
              // (Key stamps stay on the slept-nights row — the key service reads per ROOM across
              // every row, so the same-room split never reads as a second key.)
              notes: setupOnly
                ? `Setup change on Room ${ctx.fromRoom.roomNumber} from tonight: ${reason}`
                : `Room change from ${ctx.fromRoom.roomNumber}: ${reason}`,
            },
          });
        }
        if (setupOnly) return;

        // Withdraw the OLD room's H2/H3 (SIG-S7 §169/§601) — fresh ones are minted for the new
        // room on the compressed return. Matched by assignment FK, falling back to the room
        // number recorded on the checklist for pre-FK rows.
        const handoffs = await tx.handoffRecord.findMany({
          where: {
            entryId: input.entryId,
            handoffType: { in: [HandoffType.H2, HandoffType.H3] },
            state: { in: [HandoffState.CREATED, HandoffState.ACCEPTED, HandoffState.ESCALATED, HandoffState.REJECTED, HandoffState.FULFILLED] },
          },
        });
        const oldRoomHandoffs = handoffs.filter((h) => {
          if (fromAssignment && h.roomAssignmentId === fromAssignment.id) return true;
          const content = readHandoffChecklistContent(h.checklistContent);
          return content?.roomNumber === ctx.fromRoom.roomNumber;
        });
        if (oldRoomHandoffs.length > 0) {
          const ids = oldRoomHandoffs.map((h) => h.id);
          await tx.handoffRecord.updateMany({
            where: { id: { in: ids } },
            data: { state: HandoffState.CANCELLED, cancelledAt: now, cancelledBy: actor.actorId, cancelledReason: "ROOM_CHANGE" },
          });
          await tx.timerRecord.updateMany({
            where: { entityType: "HandoffRecord", entityId: { in: ids }, status: "SCHEDULED" },
            data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actor.actorId, cancelledReason: "ROOM_CHANGE" },
          });
        }
      },
    });
  } else {
    await backflowRoomChangeToS2(prisma, input.entryId, actor, {
      reason: reasonForTrace,
      fromStage: stage,
      cancelTimerCodes: ["NO_SHOW_CUTOFF_W5", "ROOM_READINESS_SLA_W23", "PRE_ARRIVAL_COUNTDOWN_W4"],
      hooks: async (tx) => {
        // Pre-occupancy: release the hold + every claim flag; the new segment re-places its own
        // hold on the substituted selection (2026-08-02 ruling — a new segment places its own
        // commitments).
        await s3HoldService.releaseCommittedHoldForRoomChange(
          tx,
          input.entryId,
          actor,
          "ROOM_CHANGE",
          entry.inquiryId,
          "COMMITTED_HOLD.RELEASED_ON_ROOM_CHANGE",
          stage,
        );
        // Pre-occupancy assignment rows are planning state, not history (the sealed segment's
        // configuration + traces keep the story) — stale rows would leak the OLD room into the
        // check-in/night-audit distinct-room iteration.
        await tx.roomNightMealPlan.deleteMany({ where: { roomAssignment: { entryId: input.entryId } } });
        await tx.handoffRecord.updateMany({
          where: { entryId: input.entryId, roomAssignmentId: { not: null } },
          data: { roomAssignmentId: null },
        });
        await tx.roomAssignment.deleteMany({ where: { entryId: input.entryId } });
      },
    });
  }

  // From here on the re-entry has committed — every failure resolves as a partial outcome.

  // The asked-for bed setups are physical registry facts for the rooms the guest is moving
  // into — record them now the change is real (best-effort: the walk continues either way,
  // and the desk bed-type dropdown remains the retry path). The service traces prior → new.
  const appliedBedTypes: Array<{ roomId: string; roomNumber: string; bedType: string }> = [];
  for (const [roomId, bedType] of requestedBedTypes) {
    const room = targetById.get(roomId)!;
    let applied = bedType;
    if (bedType !== ((room as { bedType?: string | null }).bedType ?? null)) {
      try {
        const updated = await setRoomBedType(prisma, roomId, actor, { bedType });
        applied = updated.bedType ?? bedType;
      } catch {
        /* reported as requested — the dropdown is the retry path */
      }
    }
    appliedBedTypes.push({ roomId, roomNumber: room.roomNumber, bedType: applied });
  }
  const appliedBedType = appliedBedTypes.find((b) => b.roomId === toRoomId)?.bedType ?? null;

  const newSegmentNumber = Number(entry.segmentNumber ?? 1) + 1;
  const outcomeBase = {
    entryId: input.entryId,
    originStage: String(stage),
    newSegmentNumber,
    fromRoom: { roomId: ctx.fromRoom.id, roomNumber: ctx.fromRoom.roomNumber, roomTypeName: ctx.fromRoom.roomType?.name ?? null },
    toRoom: { roomId: toRoom.id, roomNumber: toRoom.roomNumber, roomTypeName: toRoom.roomType?.name ?? null },
    toRooms: [...nightsByTarget.entries()].map(([roomId, nights]) => {
      const room = targetById.get(roomId)!;
      return { roomId, roomNumber: room.roomNumber, roomTypeName: room.roomType?.name ?? null, nights };
    }),
    keptNights: keptFromNights,
    setupOnly,
    repriced: hasReprice,
    commercialTermsChanged: commercialChanged,
    sameType,
    substitutionNights: ctx.substitutionNights,
    appliedBedType,
    appliedBedTypes,
  };

  let quotationId: string | null = null;
  let newTotal: number | null = null;
  let currency: string | null = (priorTerms?.currency as string | undefined) ?? null;

  const freshVersion = async () => {
    const row = await prisma.entry.findUniqueOrThrow({ where: { id: input.entryId }, select: { version: true } });
    return row.version;
  };
  const blockedOutcome = async (atStep: string, e: unknown): Promise<RoomChangeOutcome> => {
    const err = e as { body?: { blockingCondition?: string }; message?: string };
    const entryNow = await prisma.entry.findUnique({ where: { id: input.entryId }, select: { currentStage: true } });
    return {
      ...outcomeBase,
      pricing: { priorTotal, newTotal, delta: priorTotal != null && newTotal != null ? Number((newTotal - priorTotal).toFixed(2)) : null, currency },
      quotationId,
      walk: {
        returnedToOrigin: false,
        reachedStage: String(entryNow?.currentStage ?? "S2"),
        blocked: { atStep, code: err?.body?.blockingCondition ?? null, message: err?.message ?? "The walk could not continue" },
      },
    };
  };

  // ── 2. Substituted configuration, sealed on the new segment ────────────────────────────────
  try {
    const newSegment = await prisma.segment.findFirst({
      where: { entryId: input.entryId },
      orderBy: { segmentNumber: "desc" },
    });
    if (!newSegment) throw new ValidationError("Re-entry did not open a segment");
    const priorCriteria = (ctx.sealedConfig?.searchCriteria ?? {}) as Record<string, unknown>;
    await prisma.availabilityConfiguration.create({
      data: {
        entryId: input.entryId,
        segmentId: newSegment.id,
        searchCriteria: {
          ...priorCriteria,
          checkInDate: priorCriteria.checkInDate ?? stayCheckIn.toISOString(),
          checkOutDate: priorCriteria.checkOutDate ?? stayCheckOut.toISOString(),
          ...(setupOnly
            ? { setupChange: { roomId: input.fromRoomId, adjustments: input.adjustments ?? null, reason } }
            : { roomChange: { fromRoomId: input.fromRoomId, toRoomId, toRoomIds: distinctTargets, reason } }),
          recalledFromSegmentNumber: currentSegment.segmentNumber,
        } as Prisma.InputJsonValue,
        resultSet: (ctx.sealedConfig?.resultSet ?? {}) as Prisma.InputJsonValue,
        optionSelected: substitutedOption as unknown as Prisma.InputJsonValue,
        sealedAt: now,
        createdBy: actor.actorId,
      },
    });
  } catch (e) {
    return blockedOutcome("SUBSTITUTE_CONFIGURATION", e);
  }

  // ── 3. Silent quotation — the new segment's priced basis; nothing goes to the guest ────────
  try {
    const draft: QuotationDraftInput = {
      notes: setupOnly
        ? `Setup change on Room ${ctx.fromRoom.roomNumber} (${reason})`
        : `Room change: ${ctx.fromRoom.roomNumber} → ${targetsLabel} (${reason})`,
      ...(newCompositions ? { roomCompositions: newCompositions } : {}),
      ...(priorDiscount ? { requestedDiscount: priorDiscount } : {}),
      actorLevel: effectiveLevel,
    };
    const created = await createQuotation(prisma, input.entryId, actor.actorId, draft);
    quotationId = created.id;
    newTotal = created.totalAmount != null ? Number(created.totalAmount) : null;
    currency = created.currency ?? currency;
  } catch (e) {
    return blockedOutcome("SILENT_QUOTE", e);
  }

  // S7: the new room's assignment row was created bare inside the re-entry (the quote didn't
  // exist yet) — hydrate its composition from the silent quote now, so night audit posts the
  // NEW room's remaining nights at the figures the new segment actually priced.
  if (stage === Stage.S7 && newAssignmentIdForS7) {
    try {
      // Setup-only: the quotation prices the room for the WHOLE stay (slept nights pinned to the
      // old setup via overrides); this row covers tonight → checkout, so it freezes exactly that
      // window — the night audit's `frozenSubtotal ÷ nights` then IS tonight's true rate.
      const fields = await hydrateRoomAssignmentComposition(
        prisma,
        input.entryId,
        toRoomId,
        setupOnly ? { nights: ctx.substitutionNights.length, startDate: ctx.today } : undefined,
      );
      if (fields) {
        const rowId = newAssignmentIdForS7;
        await prisma.$transaction(async (tx) => {
          // A row re-frozen IN PLACE (setup-only, same-day second change) may already carry
          // per-night rows; (assignment, date) is unique, so clear them before the nested create.
          if (setupOnly) await tx.roomNightMealPlan.deleteMany({ where: { roomAssignmentId: rowId } });
          await tx.roomAssignment.update({ where: { id: rowId }, data: fields as Prisma.RoomAssignmentUpdateInput });
        });
      }
    } catch {
      // Non-fatal — night audit falls back to reservation.frozenRate for this room.
    }
  }

  // ── 4. S2 → S3 ──────────────────────────────────────────────────────────────────────────────
  try {
    await progressS2ToS3(prisma, input.entryId, actor.actorId, await freshVersion());
  } catch (e) {
    return blockedOutcome("S2_TO_S3", e);
  }

  // ── 5. The hold on the substituted selection ────────────────────────────────────────────────
  try {
    // Anchor = the room claimed on the most nights (mirrors the desk's preferredHoldRoomId).
    const nightsPerRoom = new Map<string, number>();
    for (const n of substitutedPicture) for (const id of n.roomIds) nightsPerRoom.set(id, (nightsPerRoom.get(id) ?? 0) + 1);
    const anchorRoomId = [...nightsPerRoom.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? toRoomId;

    if (stage === Stage.S7) {
      // In-house: the rooms are OCCUPIED — releasing/re-pinning claim flags would corrupt live
      // occupancy, so the hold ROW is refreshed in place (new segment, substituted breakdown,
      // PLACED so the S4 re-freeze can confirm it). No W3 TTL: the freeze follows in-process.
      const anchorRoom = await prisma.room.findUnique({ where: { id: anchorRoomId }, select: { roomTypeId: true } });
      const perNightBreakdown = (substitutedOption as { perNight?: unknown }).perNight ?? null;
      const newSegment = await prisma.segment.findFirst({ where: { entryId: input.entryId }, orderBy: { segmentNumber: "desc" } });
      await prisma.committedHold.upsert({
        where: { entryId: input.entryId },
        create: {
          entryId: input.entryId,
          segmentId: newSegment!.id,
          roomId: anchorRoomId,
          roomTypeId: anchorRoom?.roomTypeId ?? toRoom.roomTypeId,
          state: "PLACED",
          placedAt: now,
          placedBy: actor.actorId,
          commercialJustification: `Room change: ${reason}`,
          ttlSeconds: 900,
          expiresAt: new Date(Date.now() + 900_000),
          ...(perNightBreakdown ? { perNightBreakdown: perNightBreakdown as Prisma.InputJsonValue } : {}),
        },
        update: {
          segmentId: newSegment!.id,
          roomId: anchorRoomId,
          roomTypeId: anchorRoom?.roomTypeId ?? toRoom.roomTypeId,
          state: "PLACED",
          placedAt: now,
          placedBy: actor.actorId,
          commercialJustification: `Room change: ${reason}`,
          ttlSeconds: 900,
          expiresAt: new Date(Date.now() + 900_000),
          ...(perNightBreakdown ? { perNightBreakdown: perNightBreakdown as Prisma.InputJsonValue } : {}),
        },
      });
      await prisma.traceEvent.create({
        data: {
          eventType: "COMMITTED_HOLD.REFRESHED_FOR_ROOM_CHANGE",
          actorId: actor.actorId,
          actorLevel: actor.actorLevel,
          entityType: "CommittedHold",
          entityId: input.entryId,
          operation: "UPDATE",
          timestamp: new Date(),
          stageContext: Stage.S3,
          inquiryId: entry.inquiryId,
          entryId: input.entryId,
          payload: { entryId: input.entryId, fromRoomId: input.fromRoomId, toRoomId, toRoomIds: distinctTargets, reason },
          createdBy: actor.actorId,
        },
      }).catch(() => {});
    } else {
      await s3HoldService.placeCommittedHold(prisma, input.entryId, actor, {
        roomId: anchorRoomId,
        commercialJustification: `Room change: ${reason}`,
        trigger: "ROOM_CHANGE",
      });
    }
  } catch (e) {
    return blockedOutcome("HOLD_PLACEMENT", e);
  }

  // ── 6. Re-freeze (new Reservation row for the new segment) ─────────────────────────────────
  try {
    // Same-type: the terms are identical to what an authorized actor already confirmed, so the
    // prior confirmation's high-value authority carries (an L1's sanctioned swap must not
    // strand mid-walk on an unchanged figure). Cross-type re-tests — its value changed.
    await confirmReservation(prisma, input.entryId, actor.actorId, {
      version: await freshVersion(),
      carryHighValueAuthority: sameType,
    });
  } catch (e) {
    return blockedOutcome("RECONFIRMATION", e);
  }

  // The new voucher's answer IS the guest's room-change request — record it so the desk shows a
  // closed loop and the S4→S5 activation gate is satisfied. Best-effort: a hiccup here leaves
  // the answer capturable on the Confirm step as usual.
  try {
    const newSegmentStart = (await prisma.segment.findFirst({
      where: { entryId: input.entryId },
      orderBy: { segmentNumber: "desc" },
      select: { startedAt: true },
    }))?.startedAt;
    const voucherComm = await prisma.communicationRecord.findFirst({
      where: {
        entryId: input.entryId,
        commType: "CONFIRMATION_VOUCHER",
        direction: "OUTBOUND",
        sendStatus: "DISPATCHED",
        ...(newSegmentStart ? { createdAt: { gte: newSegmentStart } } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
    if (voucherComm && voucherComm.acknowledgementStatus !== "RECEIVED") {
      await recordCommunicationAcknowledgement(prisma, voucherComm.id, actor, {
        method: "VERBAL",
        verbatimNote: setupOnly
          ? `Guest asked for the setup change on Room ${ctx.fromRoom.roomNumber}: ${reason}. The change itself is the guest's answer to the re-issued voucher.`
          : `Guest requested the room change (${ctx.fromRoom.roomNumber} → ${targetsLabel}): ${reason}. The change itself is the guest's answer to the re-issued voucher.`,
      });
    }
  } catch {
    /* answer stays capturable on the Confirm step */
  }

  // ── 7. Back to the origin stage ─────────────────────────────────────────────────────────────
  if (stage === Stage.S5 || stage === Stage.S6) {
    try {
      const engine = await getTimerEngine();
      const activation = await runPreArrivalWindowActivationWorker(prisma, engine, { entryId: input.entryId }, { skipTaskReset: true });
      if (activation.skipped) {
        throw new ValidationError(`Pre-arrival activation skipped: ${activation.reason}`);
      }
    } catch (e) {
      return blockedOutcome("S4_TO_S5", e);
    }

    // Re-create the room-plan's assignment rows (deleted at re-entry) so S5's room block and the
    // S5→S6 gates read the substituted rooms.
    try {
      if (stage === Stage.S6 || hadAssignments) {
        const perNightCreated = await assignRoomsFromSealedPerNight(prisma, input.entryId, actor.actorId);
        if (perNightCreated.length === 0) {
          for (const roomId of substitutedDistinct) {
            const fields = await hydrateRoomAssignmentComposition(prisma, input.entryId, roomId);
            await prisma.roomAssignment.create({
              data: {
                id: await allocateReadableId(prisma, "ROOM_ASSIGNMENT" as const),
                entryId: input.entryId,
                roomId,
                assignedBy: actor.actorId,
                deficientAtAssignment: deficientById.get(roomId) === true,
                notes: `Recreated after room change (${ctx.fromRoom.roomNumber} → ${targetsLabel})`,
                ...((fields ?? {}) as Record<string, unknown>),
              } as Prisma.RoomAssignmentUncheckedCreateInput,
            });
          }
        }
      }
    } catch (e) {
      return blockedOutcome("REASSIGN_ROOMS", e);
    }

    if (stage === Stage.S6) {
      try {
        // H1 was fulfilled in the prior segment — the re-freeze minted a fresh one that would
        // otherwise demand the ceremony again mid-change (SIG-S6 §102: compressed re-entry).
        const h1 = await prisma.handoffRecord.findFirst({
          where: { entryId: input.entryId, handoffType: HandoffType.H1 },
          orderBy: { createdAt: "desc" },
        });
        if (h1 && h1.state !== HandoffState.FULFILLED) {
          await prisma.handoffRecord.update({
            where: { id: h1.id },
            data: {
              state: HandoffState.FULFILLED,
              acceptedAt: h1.acceptedAt ?? new Date(),
              acceptedBy: h1.acceptedBy ?? actor.actorId,
              fulfilledAt: new Date(),
              fulfilledBy: actor.actorId,
              isAutoFulfilled: true,
              fulfilmentEvidence: { autoFulfilled: "ROOM_CHANGE_REWALK", note: "H1 was fulfilled in the prior segment; carried across the room change." } as Prisma.InputJsonValue,
            },
          });
        }
        await progressStageS5ToS6(prisma, input.entryId, actor.actorId, await freshVersion(), true);
      } catch (e) {
        return blockedOutcome("S5_TO_S6", e);
      }
    }
  }

  if (stage === Stage.S7) {
    // Compressed return S4 → S7 (SIG-S6 §102 / SIG-S7 §42: "returns to S7 in the new segment
    // with the new room assignment applied … the stay continues"). The arrival ceremony is not
    // re-run mid-stay: the guest is in-house, the folio is LIVE, night-audit clocks never
    // stopped. Fresh H2/H3 are minted for the new room (the old room's were withdrawn at
    // re-entry), and the W4 countdown armed by the re-confirmation is cancelled.
    try {
      const jumpNow = new Date();
      await prisma.$transaction(async (tx) => {
        const s4Dwell = await tx.stageDwellRecord.findFirst({
          where: { entryId: input.entryId, stage: Stage.S4, exitedAt: null },
          orderBy: { enteredAt: "desc" },
        });
        if (s4Dwell) {
          await tx.stageDwellRecord.update({
            where: { id: s4Dwell.id },
            data: { exitedAt: jumpNow, dwellSeconds: Math.max(0, Math.floor((jumpNow.getTime() - s4Dwell.enteredAt.getTime()) / 1000)) },
          });
        }
        await tx.stageDwellRecord.create({
          data: { entryId: input.entryId, stage: Stage.S7, enteredAt: jumpNow, lastActiveAt: jumpNow, mode: "ACTIVE" } as never,
        });
        await tx.entry.update({
          where: { id: input.entryId },
          data: { currentStage: Stage.S7, version: { increment: 1 }, updatedAt: jumpNow },
        });
        // Fresh H2 (housekeeping) + H3 (F&B) for the NEW room — same shape check-in mints. A
        // setup-only change keeps the room and its standing H2/H3; nothing is re-minted.
        if (!setupOnly) {
        // Fresh H2 (housekeeping) + H3 (F&B) for the NEW room — same shape check-in mints.
        const h2Id = await allocateReadableId(tx, "HANDOFF" as const, jumpNow);
        await tx.handoffRecord.create({
          data: {
            id: h2Id,
            entryId: input.entryId,
            roomAssignmentId: newAssignmentIdForS7,
            handoffType: HandoffType.H2,
            state: HandoffState.CREATED,
            fromRole: "FRONT_DESK",
            fromActorId: actor.actorId,
            toRole: "HOUSEKEEPING",
            checklistContent: {
              roomNumber: toRoom.roomNumber,
              guestProfileId: entry.guestProfileId,
              reason: "ROOM_CHANGE",
              fromRoomNumber: ctx.fromRoom.roomNumber,
            } as Prisma.InputJsonValue,
            createdBy: actor.actorId,
            stageContext: Stage.S7,
          },
        });
        const h3Id = await allocateReadableId(tx, "HANDOFF" as const, jumpNow);
        await tx.handoffRecord.create({
          data: {
            id: h3Id,
            entryId: input.entryId,
            roomAssignmentId: newAssignmentIdForS7,
            handoffType: HandoffType.H3,
            state: HandoffState.CREATED,
            fromRole: "FRONT_DESK",
            fromActorId: actor.actorId,
            toRole: "F_AND_B",
            checklistContent: {
              roomNumber: toRoom.roomNumber,
              guestProfileId: entry.guestProfileId,
              reason: "ROOM_CHANGE",
              fromRoomNumber: ctx.fromRoom.roomNumber,
            } as Prisma.InputJsonValue,
            createdBy: actor.actorId,
            stageContext: Stage.S7,
          },
        });
        }

        await tx.traceEvent.create({
          data: {
            eventType: "ENTRY.ROOM_CHANGE_COMPRESSED_RETURN_S4_TO_S7",
            actorId: actor.actorId,
            actorLevel: actor.actorLevel,
            entityType: "Entry",
            entityId: input.entryId,
            operation: "TRANSITION",
            timestamp: jumpNow,
            stageContext: Stage.S4,
            inquiryId: entry.inquiryId,
            entryId: input.entryId,
            payload: {
              entryId: input.entryId,
              fromRoomId: input.fromRoomId,
              toRoomId,
              setupOnly,
              reason,
              compressedPer: "SIG-S6 §102 / SIG-S7 §42",
            },
            createdBy: actor.actorId,
          },
        });
      });

      // The re-confirmation armed a W4 pre-arrival countdown that is meaningless in-house.
      await cancelEntryTimersByCode(prisma, {
        entryId: input.entryId,
        timerCodes: ["PRE_ARRIVAL_COUNTDOWN_W4"],
        cancelledBy: actor.actorId,
        cancelledReason: "ROOM_CHANGE_COMPRESSED_RETURN",
      }).catch(() => {});
    } catch (e) {
      return blockedOutcome("COMPRESSED_RETURN_S7", e);
    }
  }

  const entryNow = await prisma.entry.findUniqueOrThrow({ where: { id: input.entryId }, select: { currentStage: true } });
  return {
    ...outcomeBase,
    pricing: {
      priorTotal,
      newTotal,
      delta: priorTotal != null && newTotal != null ? Number((newTotal - priorTotal).toFixed(2)) : null,
      currency,
    },
    quotationId,
    walk: {
      returnedToOrigin: String(entryNow.currentStage) === String(stage),
      reachedStage: String(entryNow.currentStage),
      blocked: null,
    },
  };
}
