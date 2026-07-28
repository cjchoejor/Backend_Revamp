import type { Prisma, PrismaClient } from "@prisma/client";
import type { EntryStatus, Stage } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";

/**
 * SEGMENT HISTORY — the entry's per-pass record (LEGPHEL Implementation Reference §1.2 / §6.2).
 *
 * A Segment is one pass through the stages. Re-entry seals the current segment read-only and
 * opens a new one (the replicate-and-revalidate doctrine); this service surfaces that stack as
 * a read-only aggregation so the desk can show WHERE each pass went, WHY it ended, and WHAT
 * commercial records it produced. Pure read — nothing persisted, no new business outcome.
 *
 * Sources, all records that already exist:
 *   - Segment rows (opened stage, startedAt, sealedAt/sealedBy, seal cause in `notes`)
 *   - StageDwellRecord — time-windowed into each segment to reconstruct the stage path walked
 *   - Reservation (segmentId unique) — the per-segment frozen commitment, if that pass confirmed
 *   - Quotation / SpeculativeHold / AmendmentEventRecord / BillingModelTransitionRecord (segmentId FKs)
 *   - ENTRY.BACKFLOW_* traces — the mode + operator reason that OPENED each re-entry segment
 *     (the Segment row's own open-reason is overwritten by the seal cause when it later seals,
 *     so the trace payload is the durable source for "why did segment N open")
 *
 * MONEY: read from the DB (Decimal) and returned as numbers — no re-summing (CLAUDE.md money rule).
 */

type Db = PrismaClient;

export interface SegmentQuotationRef {
  id: string;
  referenceNumber: string | null;
  versionNumber: number;
  state: string;
  totalAmount: number | null;
  currency: string | null;
  acceptedAt: string | null;
}

export interface SegmentReservationRef {
  id: string;
  frozenRate: number | null;
  frozenCheckIn: string | null;
  frozenCheckOut: string | null;
  frozenGuestCount: number | null;
  frozenBillingModel: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  confirmedByName: string | null;
}

export interface SegmentAmendmentRef {
  id: string;
  amendmentPath: string;
  amendmentType: string;
  reason: string;
  stageAtAmendment: Stage;
  createdAt: string;
}

export interface SegmentBillingTransitionRef {
  fromModel: string | null;
  toModel: string;
  changeSource: string | null;
  createdAt: string;
}

/**
 * The S1 work done inside one segment — what was searched and which rooms were chosen.
 * `AvailabilityConfiguration` carries `segmentId`, so unlike the folio / committed hold /
 * cancellation disclosure (all `entryId @unique` singletons) this IS genuine per-segment history.
 */
export interface SegmentAvailabilityConfigRef {
  id: string;
  checkInDate: string | null;
  checkOutDate: string | null;
  guestCount: number | null;
  roomTypeId: string | null;
  selectionShape: "single" | "whole-stay-multi" | "per-night" | "none";
  rooms: Array<{ roomId: string; roomNumber: string | null; roomTypeName: string | null }>;
  perNight: Array<{ date: string; rooms: Array<{ roomId: string; roomNumber: string | null }> }> | null;
  sealedAt: string | null;
  isStale: boolean;
  createdAt: string;
  /** Set when this configuration was produced by reusing an earlier segment's basis (§59 recall). */
  recalledFromSegmentNumber: number | null;
}

export interface SegmentHistoryItem {
  id: string;
  segmentNumber: number;
  /** Stage this pass opened at (S1 for the original booking; the backflow target for re-entries). */
  openedAtStage: Stage;
  startedAt: string;
  sealedAt: string | null;
  sealedBy: string | null;
  sealedByName: string | null;
  createdBy: string;
  createdByName: string | null;
  isActive: boolean;
  /**
   * Why this pass STARTED. Segment 1 → "BOOKING_CREATED". Re-entry segments → the operator's
   * free-text reason from the backflow trace payload (fallback: the Segment row's notes, which
   * hold the open reason until the segment is itself sealed).
   */
  openReason: string | null;
  /** How this pass came to be — the backflow that opened it. Null for segment 1 / unknown paths. */
  openedBy: { modeKey: string | null; fromStage: string | null; toStage: string | null } | null;
  /** What ENDED this pass — the seal cause written at seal time (e.g. "BACKFLOW_S4_TO_S2"). */
  sealCause: string | null;
  /** Stages walked during this pass, in order, reconstructed from dwell records. */
  stagePath: Stage[];
  /** The S1 searches + room selections made inside this segment, oldest first. */
  availabilityConfigs: SegmentAvailabilityConfigRef[];
  reservation: SegmentReservationRef | null;
  quotations: SegmentQuotationRef[];
  amendments: SegmentAmendmentRef[];
  billingModelTransitions: SegmentBillingTransitionRef[];
  speculativeHoldCount: number;
}

export interface SegmentHistory {
  entryId: string;
  generatedAt: string;
  currentStage: Stage;
  status: EntryStatus;
  currentSegmentNumber: number;
  segments: SegmentHistoryItem[];
}

function money(d: Prisma.Decimal | number | null | undefined): number | null {
  if (d == null) return null;
  const n = Number(d.toString());
  return Number.isFinite(n) ? Number(n.toFixed(2)) : null;
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

type BackflowTraceInfo = { reason: string | null; modeKey: string | null; fromStage: string | null; toStage: string | null };

/** Build the full segment history for one entry. Read-only aggregation. */
export async function buildSegmentHistory(prisma: Db, entryId: string): Promise<SegmentHistory> {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      currentStage: true,
      status: true,
      segmentNumber: true,
      reservations: {
        select: {
          id: true,
          segmentId: true,
          frozenRate: true,
          frozenCheckInDate: true,
          frozenCheckOutDate: true,
          frozenGuestCount: true,
          frozenBillingModel: true,
          confirmedAt: true,
          confirmedBy: true,
        },
      },
    },
  });
  if (!entry) throw new NotFoundError("Entry");

  const [segments, dwells, backflowTraces, configs] = await Promise.all([
    prisma.segment.findMany({
      where: { entryId },
      orderBy: { segmentNumber: "asc" },
      include: {
        quotations: {
          orderBy: { versionNumber: "asc" },
          select: { id: true, referenceNumber: true, versionNumber: true, state: true, totalAmount: true, currency: true, acceptedAt: true },
        },
        speculativeHolds: { select: { id: true } },
        amendmentEventRecords: {
          orderBy: { createdAt: "asc" },
          select: { id: true, amendmentPath: true, amendmentType: true, reason: true, stageAtAmendment: true, createdAt: true },
        },
        billingModelTransitions: {
          orderBy: { createdAt: "asc" },
          select: { fromModel: true, toModel: true, changeSource: true, createdAt: true },
        },
      },
    }),
    prisma.stageDwellRecord.findMany({
      where: { entryId },
      orderBy: { enteredAt: "asc" },
      select: { stage: true, enteredAt: true },
    }),
    // The durable "why did segment N open" source: the backflow trace payload carries the NEW
    // segment's number + the operator reason + mode. (Older S3/S8 re-entry machines emit their
    // own event types without segmentNumber — those segments fall back to Segment.notes.)
    prisma.traceEvent.findMany({
      where: { entryId, eventType: { startsWith: "ENTRY.BACKFLOW_" } },
      orderBy: { timestamp: "asc" },
      select: { payload: true },
    }),
    // Per-segment S1 work. AvailabilityConfiguration has no relation to Segment (only to Entry),
    // so it's fetched flat and grouped by segmentId below.
    prisma.availabilityConfiguration.findMany({
      where: { entryId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        segmentId: true,
        searchCriteria: true,
        optionSelected: true,
        sealedAt: true,
        isStale: true,
        createdAt: true,
      },
    }),
  ]);

  // Map segmentNumber → backflow info from trace payloads.
  const backflowBySegment = new Map<number, BackflowTraceInfo>();
  for (const t of backflowTraces) {
    const p = (t.payload ?? {}) as Record<string, unknown>;
    const segNo = typeof p.segmentNumber === "number" ? p.segmentNumber : null;
    if (segNo == null) continue;
    backflowBySegment.set(segNo, {
      reason: typeof p.reason === "string" ? p.reason : null,
      modeKey: typeof p.modeKey === "string" ? p.modeKey : null,
      fromStage: typeof p.fromStage === "string" ? p.fromStage : null,
      toStage: typeof p.toStage === "string" ? p.toStage : null,
    });
  }

  // Reservations by segment (Reservation.segmentId is unique — at most one per pass).
  const reservationBySegment = new Map(entry.reservations.map((r) => [r.segmentId, r]));

  // Resolve actor display names in one query (createdBy / sealedBy / confirmedBy are StaffUser ids;
  // system writers like "actor-seed-system" simply won't resolve and stay null).
  const actorIds = Array.from(
    new Set(
      [
        ...segments.flatMap((s) => [s.createdBy, s.sealedBy]),
        ...entry.reservations.map((r) => r.confirmedBy),
      ].filter((x): x is string => !!x),
    ),
  );
  const staff = actorIds.length
    ? await prisma.staffUser.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true } })
    : [];
  const nameOf = new Map(staff.map((s) => [s.id, s.fullName]));

  // Resolve every room referenced by any segment's selection in ONE query, so the drill-in can
  // show room numbers rather than uuids.
  const selByConfig = new Map(configs.map((c) => [c.id, readOptionSelected(c.optionSelected ?? null)]));
  const allSelectedRoomIds = Array.from(new Set(Array.from(selByConfig.values()).flatMap((s) => s.distinctRoomIds)));
  const roomRows = allSelectedRoomIds.length
    ? await prisma.room.findMany({
        where: { id: { in: allSelectedRoomIds } },
        select: { id: true, roomNumber: true, roomType: { select: { name: true } } },
      })
    : [];
  const roomById = new Map(roomRows.map((r) => [r.id, r]));
  const roomRef = (roomId: string) => ({
    roomId,
    roomNumber: roomById.get(roomId)?.roomNumber ?? null,
    roomTypeName: roomById.get(roomId)?.roomType?.name ?? null,
  });

  // Group the segment's S1 configurations by segmentId.
  const configsBySegment = new Map<string, SegmentAvailabilityConfigRef[]>();
  for (const c of configs) {
    if (!c.segmentId) continue;
    const sel = selByConfig.get(c.id)!;
    const sc = (c.searchCriteria ?? {}) as Record<string, unknown>;
    const recalledFrom = typeof sc.recalledFromSegmentNumber === "number" ? sc.recalledFromSegmentNumber : null;
    const list = configsBySegment.get(c.segmentId) ?? [];
    list.push({
      id: c.id,
      checkInDate: typeof sc.checkInDate === "string" ? sc.checkInDate : null,
      checkOutDate: typeof sc.checkOutDate === "string" ? sc.checkOutDate : null,
      guestCount: typeof sc.guestCount === "number" ? sc.guestCount : null,
      roomTypeId: typeof sc.roomTypeId === "string" ? sc.roomTypeId : null,
      selectionShape: sel.perNight
        ? "per-night"
        : sel.distinctRoomIds.length > 1
          ? "whole-stay-multi"
          : sel.distinctRoomIds.length === 1
            ? "single"
            : "none",
      rooms: sel.distinctRoomIds.map(roomRef),
      perNight: sel.perNight
        ? sel.perNight.map((n) => ({
            date: n.date,
            rooms: n.roomIds.map((id) => ({ roomId: id, roomNumber: roomById.get(id)?.roomNumber ?? null })),
          }))
        : null,
      sealedAt: iso(c.sealedAt),
      isStale: c.isStale,
      createdAt: c.createdAt.toISOString(),
      recalledFromSegmentNumber: recalledFrom,
    });
    configsBySegment.set(c.segmentId, list);
  }

  // Time-window the dwell records into segments: a dwell belongs to the last segment whose
  // startedAt <= enteredAt (both are stamped in the same transaction on transitions, so the
  // boundary dwell of a re-entry lands in the NEW segment). Records predating the first
  // segment's startedAt (clock skew between app and DB defaults) fold into segment 1.
  const pathBySegment = new Map<string, Stage[]>();
  for (const d of dwells) {
    let target = segments[0];
    for (const s of segments) {
      if (s.startedAt.getTime() <= d.enteredAt.getTime()) target = s;
      else break;
    }
    if (!target) continue;
    const path = pathBySegment.get(target.id) ?? [];
    // Collapse consecutive duplicates only — a genuine revisit (S1→S2→S1) stays visible.
    if (path[path.length - 1] !== d.stage) path.push(d.stage);
    pathBySegment.set(target.id, path);
  }

  const items: SegmentHistoryItem[] = segments.map((s) => {
    const isActive = s.sealedAt == null;
    const backflow = backflowBySegment.get(s.segmentNumber) ?? null;
    const res = reservationBySegment.get(s.id) ?? null;
    const openReason =
      s.segmentNumber === 1
        ? "BOOKING_CREATED"
        : backflow?.reason ??
          // Active segments still carry their open reason in notes (seal overwrites it later).
          (isActive ? s.notes : null);
    return {
      id: s.id,
      segmentNumber: s.segmentNumber,
      openedAtStage: s.stage,
      startedAt: s.startedAt.toISOString(),
      sealedAt: iso(s.sealedAt),
      sealedBy: s.sealedBy,
      sealedByName: s.sealedBy ? nameOf.get(s.sealedBy) ?? null : null,
      createdBy: s.createdBy,
      createdByName: nameOf.get(s.createdBy) ?? null,
      isActive,
      openReason,
      openedBy: backflow ? { modeKey: backflow.modeKey, fromStage: backflow.fromStage, toStage: backflow.toStage } : null,
      sealCause: isActive ? null : s.notes,
      stagePath: pathBySegment.get(s.id) ?? [s.stage],
      availabilityConfigs: configsBySegment.get(s.id) ?? [],
      reservation: res
        ? {
            id: res.id,
            frozenRate: money(res.frozenRate),
            frozenCheckIn: iso(res.frozenCheckInDate),
            frozenCheckOut: iso(res.frozenCheckOutDate),
            frozenGuestCount: res.frozenGuestCount,
            frozenBillingModel: res.frozenBillingModel,
            confirmedAt: iso(res.confirmedAt),
            confirmedBy: res.confirmedBy,
            confirmedByName: res.confirmedBy ? nameOf.get(res.confirmedBy) ?? null : null,
          }
        : null,
      quotations: s.quotations.map((q) => ({
        id: q.id,
        referenceNumber: q.referenceNumber,
        versionNumber: q.versionNumber,
        state: q.state,
        totalAmount: money(q.totalAmount),
        currency: q.currency,
        acceptedAt: iso(q.acceptedAt),
      })),
      amendments: s.amendmentEventRecords.map((a) => ({
        id: a.id,
        amendmentPath: a.amendmentPath,
        amendmentType: a.amendmentType,
        reason: a.reason,
        stageAtAmendment: a.stageAtAmendment,
        createdAt: a.createdAt.toISOString(),
      })),
      billingModelTransitions: s.billingModelTransitions.map((b) => ({
        fromModel: b.fromModel,
        toModel: b.toModel,
        changeSource: b.changeSource,
        createdAt: b.createdAt.toISOString(),
      })),
      speculativeHoldCount: s.speculativeHolds.length,
    };
  });

  return {
    entryId: entry.id,
    generatedAt: new Date().toISOString(),
    currentStage: entry.currentStage,
    status: entry.status,
    currentSegmentNumber: entry.segmentNumber,
    segments: items,
  };
}
