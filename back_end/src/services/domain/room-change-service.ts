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
import { enforceRoomChangeAuthorityForStage } from "../../policies/23-room-change/p58-room-change-mode-trigger.js";
import { enforceEntryActiveForStageTransition } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { enforceRoomPhysicallyAssignableForS5 } from "../../policies/01-availability/p01-s5-room-assignment-eligibility-gates.js";
import { backflowRoomChangeToS2 } from "../../state-machines/backflows-state-machine.js";
import { progressS2ToS3 } from "../../state-machines/s2-s3-state-machine.js";
import { progressStageS5ToS6 } from "../../state-machines/entry-lifecycle-state-machine.js";
import * as s3HoldService from "./s3-hold-service.js";
import { createQuotation, type QuotationDraftInput, type RoomCompositionServiceInput } from "./s2-quotation-service.js";
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

  // One conflict query per folded range for the whole pool; keep the STRONGEST claim per room
  // (a reservation outranks a hold, mirroring the S1 engine's occupied-over-held collapse).
  const claimByRoom = new Map<string, RoomBookingConflict>();
  for (const range of ranges) {
    const conflicts = await findRoomBookingConflicts(prisma, {
      roomIds: pool.map((r) => r.id),
      checkIn: range.startDate,
      checkOut: range.endDate,
      excludeEntryId: entryId,
    });
    for (const c of conflicts) {
      const prior = claimByRoom.get(c.roomId);
      if (!prior || (prior.source === "HOLD" && c.source === "RESERVED")) claimByRoom.set(c.roomId, c);
    }
  }

  const candidates: RoomChangeCandidate[] = pool
    .map((r) => {
      const physical = physicalStatusById.get(r.id) ?? null;
      const claim = claimByRoom.get(r.id) ?? null;
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
    const marker = (cfg.optionSelected as { roomChange?: { fromRoomId?: unknown; toRoomId?: unknown } } | null)?.roomChange;
    const fromRoomId = typeof marker?.fromRoomId === "string" ? marker.fromRoomId : null;
    const toRoomId = typeof marker?.toRoomId === "string" ? marker.toRoomId : null;
    if (!fromRoomId || !toRoomId) continue;
    const criteria = cfg.searchCriteria as { roomChange?: { reason?: unknown } } | null;
    const reason = typeof criteria?.roomChange?.reason === "string" ? criteria.roomChange.reason : null;
    chain.push({ fromRoomId, toRoomId, at: cfg.sealedAt ?? cfg.createdAt, reason });
    originOf.set(toRoomId, originOf.get(fromRoomId) ?? fromRoomId);
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
  toRoom: { roomId: string; roomNumber: string; roomTypeName: string | null };
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
  walk: {
    returnedToOrigin: boolean;
    reachedStage: string;
    blocked: { atStep: string; code: string | null; message: string } | null;
  };
};

export async function changeRoomToNewSegment(
  prisma: PrismaClient,
  actor: Actor,
  input: { entryId: string; fromRoomId: string; toRoomId: string; reason: string },
): Promise<RoomChangeOutcome> {
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("reason is required");
  if (!input.fromRoomId?.trim() || !input.toRoomId?.trim()) throw new ValidationError("fromRoomId and toRoomId are required");
  if (input.fromRoomId === input.toRoomId) throw new ValidationError("The replacement room is the same room");

  const ctx = await loadRoomChangeContext(prisma, input.entryId, input.fromRoomId);
  const { entry, stage } = ctx;

  const toRoom = await prisma.room.findUnique({ where: { id: input.toRoomId }, include: { roomType: true } });
  if (!toRoom) throw new NotFoundError("Room");
  if (toRoom.isShadowInventory) throw new ValidationError("That room is shadow inventory and cannot be booked");

  if (ctx.claimedRoomIds.has(input.toRoomId)) {
    // At S7 a moved-out room keeps its slept-night claim (the split end-dates its assignment,
    // it never leaves the plan), so "already part of this booking" would be misleading — name
    // the real limit: returning to a room this stay already slept in would give the room two
    // composition rows and double-price its nights, so it is not supported mid-stay.
    const toRoomNights = ctx.picture.filter((n) => n.roomIds.includes(input.toRoomId)).map((n) => n.date);
    const onlyPastNights = toRoomNights.length > 0 && toRoomNights.every((d) => d < ctx.todayIso);
    throw new ValidationError(
      stage === Stage.S7 && onlyPastNights
        ? `Room ${toRoom.roomNumber} already held this booking's earlier nights this stay — moving back into a moved-out room isn't supported mid-stay; pick a different room`
        : "That room is already part of this booking — pick a room outside the current plan",
    );
  }

  // Authority follows WHAT the change does, not the stage (2026-08-13 ruling): a same-type
  // swap is desk logistics (L1+); a cross-type move is an upgrade/downgrade that re-prices
  // the stay, so it needs FOM+ (L2+).
  const sameType = toRoom.roomTypeId === ctx.fromRoom.roomTypeId;
  enforceRoomChangeAuthorityForStage({ currentStage: String(stage), actorLevel: actor.actorLevel, sameType });

  // ── Availability, validated the way S1 validates it (recall-plus-revalidate doctrine) ──────
  const ranges = foldIsoNightsToRanges(ctx.substitutionNights);
  for (const range of ranges) {
    enforceCommittedHoldRoomPhysicallyUsable({
      roomNumber: toRoom.roomNumber,
      isBlocked: toRoom.isBlocked,
      blockedReason: toRoom.blockedReason,
      isUnderMaintenance: toRoom.isUnderMaintenance,
      maintenanceDeadline: toRoom.maintenanceDeadline,
      checkIn: range.startDate,
      checkOut: range.endDate,
    });
    const conflicts = await findRoomBookingConflicts(prisma, {
      roomIds: [input.toRoomId],
      checkIn: range.startDate,
      checkOut: range.endDate,
      excludeEntryId: input.entryId,
    });
    enforceNoOverlappingBookingForCommittedHold({
      conflicts: conflicts.map((c) => ({ ...c, roomNumber: toRoom.roomNumber })),
    });
  }
  // The guest moves NOW at S6/S7 (or the walk re-verifies readiness at S5→S6), so the room has
  // to be physically ready for an immediate move-in — same gate S5 assignment applies.
  if (stage === Stage.S6 || stage === Stage.S7) {
    enforceRoomPhysicallyAssignableForS5({
      physicalState: toRoom.physicalState,
      expectedReadyAt: toRoom.expectedReadyAt,
      arrival: new Date(),
    });
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
  const priorTerms = (operative?.commercialTerms ?? null) as Record<string, unknown> | null;
  const priorCompositions = Array.isArray(priorTerms?.roomCompositions)
    ? (priorTerms!.roomCompositions as RoomCompositionServiceInput[])
    : null;
  const priorTotal = operative?.totalAmount != null ? Number(operative.totalAmount) : null;

  // Capacity: the party moving rooms must fit the new room's type.
  const movingComposition = priorCompositions?.find((c) => c.roomId === input.fromRoomId) ?? null;
  const movingOccupants =
    movingComposition?.occupantCount ??
    ((movingComposition?.adultCount ?? 0) + (movingComposition?.cnb6To10Count ?? 0) + (movingComposition?.cnbUnder6Count ?? 0) || null);
  const maxOccupancy = (toRoom.roomType as { maxOccupancy?: number } | null)?.maxOccupancy ?? null;
  if (movingOccupants != null && maxOccupancy != null && movingOccupants > maxOccupancy) {
    throw new ValidationError(
      `Room ${toRoom.roomNumber} (${toRoom.roomType?.name ?? "its type"}) sleeps ${maxOccupancy} — the ${movingOccupants} guests in Room ${ctx.fromRoom.roomNumber} do not fit`,
    );
  }

  // ── The substituted room plan ───────────────────────────────────────────────────────────────
  const substituteNightSet = new Set(ctx.substitutionNights);
  const substitutedPicture = ctx.picture.map((n) => ({
    date: n.date,
    roomIds: n.roomIds.map((id) => (id === input.fromRoomId && substituteNightSet.has(n.date) ? input.toRoomId : id)),
  }));
  const substitutedDistinct = Array.from(new Set(substitutedPicture.flatMap((n) => n.roomIds)));
  const priorSel = readOptionSelected(ctx.sealedConfig?.optionSelected ?? null);
  // S7 always needs the per-night shape (the split IS per-night); pre-occupancy keeps the
  // original shape family so downstream displays don't change form for a simple swap.
  const emitPerNight = stage === Stage.S7 || !!priorSel.perNight;
  const deficientById = new Map<string, boolean>();
  {
    const involved = await prisma.room.findMany({
      where: { id: { in: substitutedDistinct } },
      select: { id: true, isDeficient: true },
    });
    for (const r of involved) deficientById.set(r.id, r.isDeficient === true);
  }
  const anyDeficient = substitutedDistinct.some((id) => deficientById.get(id) === true);
  const substitutedOption = emitPerNight
    ? {
        perNight: substitutedPicture.map((n) => ({
          date: n.date,
          roomIds: n.roomIds.map((roomId) => ({ roomId, isDeficient: deficientById.get(roomId) === true })),
        })),
        isDeficient: anyDeficient,
        roomChange: { fromRoomId: input.fromRoomId, toRoomId: input.toRoomId },
      }
    : {
        roomIds: substitutedDistinct.map((roomId) => ({ roomId, isDeficient: deficientById.get(roomId) === true })),
        isDeficient: anyDeficient,
        roomChange: { fromRoomId: input.fromRoomId, toRoomId: input.toRoomId },
      };

  // ── The carried compositions, with the one room substituted ────────────────────────────────
  let newCompositions: RoomCompositionServiceInput[] | undefined;
  if (priorCompositions && priorCompositions.length > 0) {
    if (stage === Stage.S7 && movingComposition) {
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
          roomId: input.toRoomId,
          nightMealOverrides: newOverrides,
          // A negotiated rate was negotiated for the OLD room's type — a cross-type move prices
          // at the new type's own resolved rate instead. Same-type keeps the negotiation.
          ...(sameType ? {} : { negotiatedRoomRate: undefined }),
        },
      ];
    } else {
      newCompositions = priorCompositions.map((c) =>
        c.roomId === input.fromRoomId
          ? { ...c, roomId: input.toRoomId, ...(sameType ? {} : { negotiatedRoomRate: undefined }) }
          : { ...c },
      );
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

  // Carried discount: what the prior quote recorded, re-stamped under the authority that
  // already approved it (the approval carries WITH the concession — re-testing the acting
  // operator's band would let a room swap silently strip an FOM-approved discount).
  const priorDiscount = (priorTerms?.requestedDiscount ?? null) as
    | { discountPercent?: number; discountAmount?: number; discountBasis: string }
    | null;
  const priorApprovalLevel = ((priorTerms?.discountAuthority as { approvedLevel?: string } | undefined)?.approvedLevel ??
    null) as "L1" | "L2" | "L3" | "L4" | null;
  const RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
  const effectiveLevel: "L1" | "L2" | "L3" | "L4" =
    priorDiscount && priorApprovalLevel && (RANK[priorApprovalLevel] ?? 0) > (RANK[actor.actorLevel] ?? 0)
      ? priorApprovalLevel
      : actor.actorLevel;

  const hadAssignments = entry.roomAssignments.length > 0;
  const fromAssignment = entry.roomAssignments.find((a) => a.roomId === input.fromRoomId) ?? null;
  const stayCheckIn = ctx.checkIn;
  const stayCheckOut = ctx.checkOut;
  const now = new Date();
  let newAssignmentIdForS7: string | null = null;

  // ── 1. The governed re-entry (new segment at S2) with origin-specific side effects ─────────
  const reasonForTrace = `ROOM_CHANGE: ${reason}`;
  if (stage === Stage.S7) {
    await backflowRoomChangeToS2(prisma, input.entryId, actor, {
      reason: reasonForTrace,
      fromStage: stage,
      hooks: async (tx) => {
        // Physical swap NOW — the guest moves tonight; the paperwork walk follows (SIG-S7 §264:
        // old room OCCUPIED → DEPARTED_DIRTY, new room OCCUPIED).
        await transitionRoomClaimState(tx, {
          roomId: input.fromRoomId,
          toState: InventoryClaimState.DEPARTED_DIRTY,
          actorId: actor.actorId,
          entryId: input.entryId,
          reason: "S7 in-place room change",
          now,
        });
        await transitionRoomClaimState(tx, {
          roomId: input.toRoomId,
          toState: InventoryClaimState.OCCUPIED,
          actorId: actor.actorId,
          entryId: input.entryId,
          reason: "S7 in-place room change",
          now,
        });

        // Dated assignment split: the old room's row ends tonight (its frozen figures scaled to
        // the nights it actually covered, so `frozenSubtotal ÷ nights` stays the true per-night
        // rate), the new room's row runs tonight → checkout. Night audit already respects the
        // [startDate, endDate) window, so past nights stay billed on the old room and future
        // audits post to the new one.
        if (fromAssignment) {
          const aStart = fromAssignment.startDate ?? stayCheckIn;
          const aEnd = fromAssignment.endDate ?? stayCheckOut;
          const totalNights = Math.max(1, Math.round((aEnd.getTime() - aStart.getTime()) / DAY_MS));
          const sleptNights = Math.max(0, Math.min(totalNights, Math.round((ctx.today.getTime() - aStart.getTime()) / DAY_MS)));
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
        const newAssignmentId = await allocateReadableId(tx, "ROOM_ASSIGNMENT" as const, now);
        newAssignmentIdForS7 = newAssignmentId;
        await tx.roomAssignment.create({
          data: {
            id: newAssignmentId,
            entryId: input.entryId,
            roomId: input.toRoomId,
            assignedBy: actor.actorId,
            deficientAtAssignment: toRoom.isDeficient === true,
            startDate: ctx.today,
            endDate: stayCheckOut,
            notes: `Room change from ${ctx.fromRoom.roomNumber}: ${reason}`,
          },
        });

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
  const newSegmentNumber = Number(entry.segmentNumber ?? 1) + 1;
  const outcomeBase = {
    entryId: input.entryId,
    originStage: String(stage),
    newSegmentNumber,
    fromRoom: { roomId: ctx.fromRoom.id, roomNumber: ctx.fromRoom.roomNumber, roomTypeName: ctx.fromRoom.roomType?.name ?? null },
    toRoom: { roomId: toRoom.id, roomNumber: toRoom.roomNumber, roomTypeName: toRoom.roomType?.name ?? null },
    sameType,
    substitutionNights: ctx.substitutionNights,
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
          roomChange: { fromRoomId: input.fromRoomId, toRoomId: input.toRoomId, reason },
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
      notes: `Room change: ${ctx.fromRoom.roomNumber} → ${toRoom.roomNumber} (${reason})`,
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
      const fields = await hydrateRoomAssignmentComposition(prisma, input.entryId, input.toRoomId);
      if (fields) {
        await prisma.roomAssignment.update({ where: { id: newAssignmentIdForS7 }, data: fields as Prisma.RoomAssignmentUpdateInput });
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
    const anchorRoomId = [...nightsPerRoom.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? input.toRoomId;

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
          payload: { entryId: input.entryId, fromRoomId: input.fromRoomId, toRoomId: input.toRoomId, reason },
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
        verbatimNote: `Guest requested the room change (${ctx.fromRoom.roomNumber} → ${toRoom.roomNumber}): ${reason}. The change itself is the guest's answer to the re-issued voucher.`,
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
                notes: `Recreated after room change (${ctx.fromRoom.roomNumber} → ${toRoom.roomNumber})`,
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
              toRoomId: input.toRoomId,
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
