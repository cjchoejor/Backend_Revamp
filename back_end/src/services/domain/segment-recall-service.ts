import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { AppError, NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { runAvailabilityEngineForEntry } from "./s1-availability-service.js";
import * as backflowsSM from "../../state-machines/backflows-state-machine.js";
import { initiateS3ToS1Backflow, initiateS3ToS2Backflow } from "../../state-machines/s3-reentry-state-machine.js";

/**
 * CROSS-SEGMENT CONFIGURATION RECALL — "reuse a prior segment as the basis".
 *
 * Canon Block 10 §59 "Availability Configuration and Recall" is the authority. The guest says
 * "actually I prefer what we had in segment 1"; the desk must be able to get back to that basis
 * without re-navigating S1 from scratch (§59 M.1 — explicitly "cross-stage and cross-segment
 * recall"; M.2 is that exact scenario).
 *
 * This is deliberately NOT a copy. The governing constraints:
 *
 *   M.5  "Recall is not a blind restore — it is a recall-plus-revalidate operation."
 *        No actor may select a recalled configuration without viability checks running.
 *   M.9  "The recalled configuration is not modified — a new configuration derived from the
 *        recalled one may be created if conditions changed." So the prior (sealed) segment's
 *        config is read-only here; we always write a NEW config on the CURRENT segment.
 *   M.4  "FOM decides when recalled options have changed conditions." Material change →
 *        L2 authority required to apply (enforced below).
 *   M.8  The viability check must include the current DEFICIENT flag: a room that was clean
 *        when segment 1 was configured but now carries a DEFICIENT flag is a material change.
 *   M.13 Forbidden: selecting a recalled configuration without viability checks, and
 *        "treating recall as a rollback — it is a new selection informed by historical data".
 *
 * The Implementation Reference §6.6 names the doctrine this serves: "replicate-and-revalidate —
 * silent mutation of prior commercial reality is the forbidden pattern."
 *
 * EVIDENCE (M.9/M.11): every run records what was checked and what changed as a TraceEvent
 * carrying the spec's delta shape (the same three booleans + three deltas as
 * `RevalidationDeltaRecord`, which is FK-bound to ProcessingLock and so cannot host a recall).
 */

type ActorLevel = "L1" | "L2" | "L3" | "L4" | "SYSTEM";
type Actor = { actorId: string; actorLevel: ActorLevel };

const RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4, SYSTEM: 4 };

/** Stages where swapping the commercial basis is still legitimate (pre-freeze). */
const RECALL_ALLOWED_STAGES = new Set(["S1", "S2", "S3"]);

export interface RecallViabilityDelta {
  availabilityChanged: boolean;
  deficientStatusChanged: boolean;
  pricingChanged: boolean;
  availabilityDelta: Array<{ roomId: string; roomNumber: string | null; was: string; now: string }> | null;
  deficientDelta: Array<{ roomId: string; roomNumber: string | null; wasDeficient: boolean; nowDeficient: boolean; category: string | null }> | null;
  pricingDelta: Array<{ roomId: string; roomNumber: string | null; wasRate: number | null; nowRate: number | null; currency: string | null }> | null;
}

export interface SegmentRecallOutcome {
  entryId: string;
  /** The segment being recalled FROM (sealed history). */
  fromSegmentNumber: number;
  /** The segment the derived configuration lands on (the active segment). */
  toSegmentNumber: number;
  sourceConfigurationId: string;
  /** Selection captured in the recalled segment, resolved to room numbers. */
  recalledSelection: {
    shape: "single" | "whole-stay-multi" | "per-night" | "none";
    rooms: Array<{ roomId: string; roomNumber: string | null; roomTypeName: string | null }>;
    distinctRoomCount: number;
  };
  searchCriteria: Record<string, unknown>;
  delta: RecallViabilityDelta;
  /** True when any viability check moved — §59 M.4 routes these to FOM. */
  requiresFomDecision: boolean;
  /** Operator-readable list of what moved since the segment was configured. */
  materialChanges: string[];
  /** Rooms from the recalled selection that are no longer offerable and were NOT carried forward. */
  droppedRooms: Array<{ roomId: string; roomNumber: string | null; reason: string }>;
  applied: boolean;
  newConfigurationId: string | null;
  /** The revalidated availability result — same shape the S1 search returns. */
  result: unknown;
}

type RoomState = { bucket: "available" | "deficient" | "unavailable"; isDeficient: boolean; category: string | null; rate: number | null; currency: string | null; roomNumber: string | null };

/** Index a persisted/fresh engine result by room id so the two can be compared room-by-room. */
function indexRooms(resultSet: unknown): Map<string, RoomState> {
  const out = new Map<string, RoomState>();
  const rs = (resultSet ?? {}) as Record<string, unknown>;
  const buckets: Array<["available" | "deficient" | "unavailable", unknown]> = [
    ["available", rs.availableRooms],
    ["deficient", rs.deficientRooms],
    ["unavailable", rs.unavailableRooms],
  ];
  for (const [bucket, list] of buckets) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const r = (raw ?? {}) as Record<string, unknown>;
      // Persisted result sets key rooms as `inventoryId`; the API-shaped ones add `roomId`.
      const id = typeof r.roomId === "string" ? r.roomId : typeof r.inventoryId === "string" ? r.inventoryId : null;
      if (!id) continue;
      const chip = (r.pricingIndicative ?? null) as Record<string, unknown> | null;
      const rate = chip && typeof chip.rateAmount === "number" ? chip.rateAmount : null;
      out.set(id, {
        bucket,
        isDeficient: r.isDeficient === true,
        category: typeof r.deficientConditionCategory === "string" ? r.deficientConditionCategory : null,
        rate,
        currency: chip && typeof chip.currency === "string" ? chip.currency : null,
        roomNumber: typeof r.roomNumber === "string" ? r.roomNumber : null,
      });
    }
  }
  return out;
}

const OFFERABLE = new Set(["available", "deficient"]);

/**
 * Recall a prior segment's availability configuration onto the current segment, revalidating it
 * against present state. `apply: false` (default) previews only — it runs every viability check
 * and records the evidence, but writes no configuration.
 */
export async function recallSegmentConfiguration(
  prisma: PrismaClient,
  input: { entryId: string; fromSegmentNumber: number; actor: Actor; apply?: boolean; reason?: string },
): Promise<SegmentRecallOutcome> {
  const { entryId, fromSegmentNumber, actor } = input;
  const apply = input.apply === true;

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { segments: { orderBy: { segmentNumber: "asc" } } },
  });
  if (!entry) throw new NotFoundError("Entry");

  if (!RECALL_ALLOWED_STAGES.has(String(entry.currentStage))) {
    // Post-freeze the commercial basis is bound to the confirmed reservation. Changing it means
    // a re-entry first (which opens a fresh segment), then recall inside that segment — never an
    // in-place swap of a frozen basis (§59 M.13 forbids treating recall as a rollback).
    throw new ValidationError(
      `Configuration recall is only available before the booking is frozen (entry is at ${entry.currentStage}). Open a re-entry to an earlier step first, then reuse the segment inside it.`,
    );
  }

  const current = entry.segments[entry.segments.length - 1];
  if (!current) throw new ValidationError("Entry has no segment");
  if (fromSegmentNumber === current.segmentNumber) {
    throw new ValidationError("That is the segment you are already on — pick an earlier segment to reuse.");
  }
  const source = entry.segments.find((s) => s.segmentNumber === fromSegmentNumber);
  if (!source) throw new NotFoundError(`Segment ${fromSegmentNumber} for this entry`);

  // The recalled basis is the configuration IN FORCE during the source segment — its own if it
  // sealed one, otherwise the newest selection it inherited from an earlier segment. Only a
  // segment opened at S1 seals a configuration of its own; one opened at S2/S3 by re-entry runs on
  // the selection it inherited, and asking to reuse it plainly means "reuse what it was working
  // from". Requiring the segment to own a row made every such segment un-reusable.
  const inForceSegmentIds = entry.segments
    .filter((s) => s.segmentNumber <= fromSegmentNumber)
    .map((s) => s.id);
  const sourceConfig = await prisma.availabilityConfiguration.findFirst({
    where: { entryId, segmentId: { in: inForceSegmentIds }, NOT: { optionSelected: { equals: Prisma.DbNull } } },
    orderBy: [{ createdAt: "desc" }],
  });
  if (!sourceConfig) {
    throw new ValidationError(
      `Segment ${fromSegmentNumber} has no chosen room configuration to reuse, and inherited none from an earlier segment.`,
    );
  }
  // Which segment the basis actually came from — reported so the operator isn't told they are
  // reusing segment 3 when the selection is really segment 1's.
  const basisSegmentNumber =
    entry.segments.find((s) => s.id === sourceConfig.segmentId)?.segmentNumber ?? fromSegmentNumber;
  const basisInherited = basisSegmentNumber !== fromSegmentNumber;

  const sel = readOptionSelected(sourceConfig.optionSelected ?? null);
  if (sel.distinctRoomIds.length === 0) {
    throw new ValidationError(`Segment ${fromSegmentNumber} has no chosen rooms to reuse.`);
  }

  // Replicate: the recalled segment's own search criteria are the basis (that is what "I prefer
  // segment 1" means) — not the entry's current dates.
  const sc = (sourceConfig.searchCriteria ?? {}) as Record<string, unknown>;
  const engineInput = {
    roomTypeId: typeof sc.roomTypeId === "string" ? sc.roomTypeId : undefined,
    checkInDate: String(sc.checkInDate ?? ""),
    checkOutDate: String(sc.checkOutDate ?? ""),
    guestCount: typeof sc.guestCount === "number" ? sc.guestCount : sc.guestCount != null ? Number(sc.guestCount) : undefined,
    useType: typeof sc.useType === "string" ? sc.useType : undefined,
  };
  if (!engineInput.checkInDate.trim() || !engineInput.checkOutDate.trim()) {
    throw new ValidationError(`Segment ${fromSegmentNumber}'s configuration is missing its dates — it cannot be revalidated.`);
  }

  // Revalidate: re-run the engine against present state.
  const { engineOut, resultForApi } = await runAvailabilityEngineForEntry(prisma, entry, engineInput, actor.actorLevel);

  const before = indexRooms(sourceConfig.resultSet);
  const after = indexRooms(engineOut);

  // Resolve room numbers/types for everything we report on (the persisted result may predate
  // room renames, so the Room table is authoritative for display).
  const rooms = await prisma.room.findMany({
    where: { id: { in: sel.distinctRoomIds } },
    select: { id: true, roomNumber: true, isDeficient: true, deficientConditionCategory: true, roomType: { select: { name: true } } },
  });
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const labelOf = (id: string) => roomById.get(id)?.roomNumber ?? before.get(id)?.roomNumber ?? after.get(id)?.roomNumber ?? null;

  const availabilityDelta: NonNullable<RecallViabilityDelta["availabilityDelta"]> = [];
  const deficientDelta: NonNullable<RecallViabilityDelta["deficientDelta"]> = [];
  const pricingDelta: NonNullable<RecallViabilityDelta["pricingDelta"]> = [];
  const droppedRooms: SegmentRecallOutcome["droppedRooms"] = [];
  const stillViable: string[] = [];

  for (const roomId of sel.distinctRoomIds) {
    const was = before.get(roomId);
    const now = after.get(roomId);
    const wasBucket = was?.bucket ?? "unavailable";
    const nowBucket = now?.bucket ?? "unavailable";

    if (wasBucket !== nowBucket) {
      availabilityDelta.push({ roomId, roomNumber: labelOf(roomId), was: wasBucket, now: nowBucket });
    }
    if (OFFERABLE.has(nowBucket)) {
      stillViable.push(roomId);
    } else {
      droppedRooms.push({
        roomId,
        roomNumber: labelOf(roomId),
        reason: nowBucket === "unavailable" ? "No longer available for these dates" : "No longer offerable",
      });
    }

    // §59 M.8 — DEFICIENT flag status is an explicit part of the viability check. The live Room
    // row is authoritative for "now"; fall back to the fresh engine result.
    const nowDeficient = roomById.get(roomId)?.isDeficient ?? now?.isDeficient ?? false;
    const wasDeficient = was?.isDeficient ?? false;
    if (wasDeficient !== nowDeficient) {
      deficientDelta.push({
        roomId,
        roomNumber: labelOf(roomId),
        wasDeficient,
        nowDeficient,
        category: roomById.get(roomId)?.deficientConditionCategory ?? now?.category ?? null,
      });
    }

    const wasRate = was?.rate ?? null;
    const nowRate = now?.rate ?? null;
    if (wasRate !== null && nowRate !== null && wasRate !== nowRate) {
      pricingDelta.push({ roomId, roomNumber: labelOf(roomId), wasRate, nowRate, currency: now?.currency ?? was?.currency ?? null });
    }
  }

  const delta: RecallViabilityDelta = {
    availabilityChanged: availabilityDelta.length > 0,
    deficientStatusChanged: deficientDelta.length > 0,
    pricingChanged: pricingDelta.length > 0,
    availabilityDelta: availabilityDelta.length ? availabilityDelta : null,
    deficientDelta: deficientDelta.length ? deficientDelta : null,
    pricingDelta: pricingDelta.length ? pricingDelta : null,
  };
  const requiresFomDecision = delta.availabilityChanged || delta.deficientStatusChanged || delta.pricingChanged;

  const materialChanges: string[] = [
    ...droppedRooms.map((d) => `Room ${d.roomNumber ?? d.roomId.slice(0, 8)} is no longer available for these dates`),
    ...deficientDelta.map((d) =>
      d.nowDeficient
        ? `Room ${d.roomNumber ?? d.roomId.slice(0, 8)} now carries a deficiency${d.category ? ` (${d.category})` : ""}`
        : `Room ${d.roomNumber ?? d.roomId.slice(0, 8)} no longer carries a deficiency`,
    ),
    ...pricingDelta.map(
      (p) => `Indicative rate for room ${p.roomNumber ?? p.roomId.slice(0, 8)} moved from ${p.wasRate} to ${p.nowRate}`,
    ),
  ];

  const recalledSelection: SegmentRecallOutcome["recalledSelection"] = {
    shape: sel.perNight ? "per-night" : sel.distinctRoomIds.length > 1 ? "whole-stay-multi" : "single",
    rooms: sel.distinctRoomIds.map((id) => ({
      roomId: id,
      roomNumber: labelOf(id),
      roomTypeName: roomById.get(id)?.roomType?.name ?? null,
    })),
    distinctRoomCount: sel.distinctRoomIds.length,
  };

  const base: Omit<SegmentRecallOutcome, "applied" | "newConfigurationId"> = {
    entryId,
    fromSegmentNumber,
    toSegmentNumber: current.segmentNumber,
    sourceConfigurationId: sourceConfig.id,
    recalledSelection,
    searchCriteria: sc,
    delta,
    requiresFomDecision,
    materialChanges,
    droppedRooms,
    result: resultForApi,
  };

  const evidencePayload = {
    entryId,
    fromSegmentNumber,
    toSegmentNumber: current.segmentNumber,
    sourceConfigurationId: sourceConfig.id,
    basisSegmentNumber,
    basisInherited,
    checksRun: ["AVAILABILITY", "DEFICIENT_FLAG", "INDICATIVE_PRICING"],
    ...delta,
    requiresFomDecision,
    materialChanges,
    droppedRoomIds: droppedRooms.map((d) => d.roomId),
    reason: input.reason ?? null,
  };

  // Preview — record the viability checks (M.11) without writing a configuration.
  if (!apply) {
    await prisma.traceEvent.create({
      data: {
        eventType: "SEGMENT.RECALL_REVALIDATED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel as any,
        entityType: "Segment",
        entityId: source.id,
        operation: "READ",
        timestamp: new Date(),
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: evidencePayload,
        createdBy: actor.actorId,
      },
    }).catch(() => {});
    return { ...base, applied: false, newConfigurationId: null };
  }

  // §59 M.4 — FOM decides when recalled conditions have changed. L1 may reuse an unchanged
  // segment; anything that moved needs L2+.
  if (requiresFomDecision && RANK[actor.actorLevel] < RANK.L2) {
    await prisma.traceEvent.create({
      data: {
        eventType: "SEGMENT.RECALL_BLOCKED_PENDING_FOM",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel as any,
        entityType: "Segment",
        entityId: source.id,
        operation: "ALERT",
        timestamp: new Date(),
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: evidencePayload,
        createdBy: actor.actorId,
      },
    }).catch(() => {});
    throw new PolicyGateBlockedError(
      "AUTH_REQUIRED_L2",
      `Conditions have changed since segment ${fromSegmentNumber} was configured — FOM authority is required to reuse it. ${materialChanges.join("; ")}`,
      { requiresFomDecision: true, materialChanges, delta },
    );
  }

  if (stillViable.length === 0) {
    throw new PolicyGateBlockedError(
      "RECALL_NO_VIABLE_ROOMS",
      `None of segment ${fromSegmentNumber}'s rooms are still available for these dates — search fresh instead of reusing it.`,
      { droppedRooms },
    );
  }

  // Carry the selection forward, narrowed to rooms that survived revalidation. Left UNSEALED so
  // the operator confirms it through the normal save-selection path — a recall is "a new
  // selection informed by historical data" (M.13), not an automatic commitment.
  // `readOptionSelected` normalises per-night rooms to plain id strings; re-emit the persisted
  // `[{ roomId, isDeficient }]` shape so downstream readers see a well-formed seal.
  const carriedSelection = sel.perNight
    ? {
        perNight: sel.perNight
          .map((n) => ({
            date: n.date,
            roomIds: n.roomIds
              .filter((roomId) => stillViable.includes(roomId))
              .map((roomId) => ({ roomId, isDeficient: before.get(roomId)?.isDeficient === true })),
          }))
          .filter((n) => n.roomIds.length > 0),
        isDeficient: sel.anyDeficient,
        recalledFromSegmentNumber: fromSegmentNumber,
      }
    : {
        roomIds: sel.distinctRoomIds.filter((id) => stillViable.includes(id)).map((id) => ({ roomId: id, isDeficient: before.get(id)?.isDeficient === true })),
        isDeficient: sel.anyDeficient,
        recalledFromSegmentNumber: fromSegmentNumber,
      };

  return prisma.$transaction(async (tx) => {
    // M.9 — the recalled configuration is NOT modified. A new one, derived from it, is created
    // on the current segment.
    const created = await tx.availabilityConfiguration.create({
      data: {
        entryId,
        segmentId: current.id,
        searchCriteria: {
          ...sc,
          recalledFromSegmentNumber: fromSegmentNumber,
          recalledFromConfigurationId: sourceConfig.id,
          // Differs from recalledFromSegmentNumber when the source segment inherited its basis.
          basisSegmentNumber,
        } as any,
        resultSet: engineOut as any,
        optionSelected: carriedSelection as any,
        createdBy: actor.actorId,
      },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "SEGMENT.RECALL_APPLIED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel as any,
        entityType: "AvailabilityConfiguration",
        entityId: created.id,
        operation: "CREATE",
        timestamp: new Date(),
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          ...evidencePayload,
          newConfigurationId: created.id,
          fomDecisionBy: requiresFomDecision ? actor.actorId : null,
          fomDecisionLevel: requiresFomDecision ? actor.actorLevel : null,
          carriedRoomIds: stillViable,
        },
        createdBy: actor.actorId,
      },
    });

    return { ...base, applied: true, newConfigurationId: created.id };
  });
}

// ============================================================================
// DUPLICATE A SEGMENT — open a new segment and carry a prior one's basis into it
// ============================================================================

/**
 * The composite operator action: "copy segment N and start a new segment from it."
 *
 * This is two governed operations run back to back, NOT a record copy:
 *
 *   1. A **re-entry** (backflow) — this is what actually creates the new Segment. It carries its
 *      own authority gate, mode-registry check, consequence computation, timer cancellations and
 *      hold/invoice side effects. A Segment is always the *product* of a governed transition;
 *      duplicating a Segment row directly would bypass all of that.
 *   2. A **recall-plus-revalidate** of the source segment's configuration onto the segment the
 *      re-entry just opened (Canon Block 10 §59) — availability, DEFICIENT flags and indicative
 *      rate are re-checked, and material changes still require FOM authority (§59 M.4).
 *
 * Failure shape matters here. The re-entry commits first and has irreversible side effects
 * (timers cancelled, holds released, invoices superseded), so if the recall is then blocked by the
 * FOM gate we do NOT pretend the whole thing failed — the new segment exists. We return
 * `prefilled: false` with the blocking detail so the desk can say "new segment is open; the basis
 * needs FOM approval before it carries over", and the operator can approve it from the panel.
 */
export interface SegmentDuplicateOutcome {
  entryId: string;
  fromSegmentNumber: number;
  newSegmentNumber: number;
  fromStage: string;
  toStage: string;
  /** The new segment was opened by the re-entry. Always true when this resolves. */
  duplicated: true;
  /** The source segment's basis was carried onto the new segment. */
  prefilled: boolean;
  recall: SegmentRecallOutcome | null;
  /** Set when the re-entry succeeded but the recall was blocked (FOM gate / no viable rooms). */
  recallBlocked: { code: string | null; message: string; materialChanges: string[] } | null;
}

/** Re-entries that land on a stage where a configuration basis is still meaningful (S1–S3). */
const DUPLICATE_ROUTES: Record<string, string[]> = {
  S2: ["S1"],
  S3: ["S1", "S2"],
  S4: ["S1", "S2", "S3"],
  S5: ["S1"],
  S7: ["S2", "S3"],
};

async function runReEntry(
  prisma: PrismaClient,
  fromStage: string,
  toStage: string,
  entryId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  reason: string,
) {
  const key = `${fromStage}->${toStage}`;
  switch (key) {
    case "S2->S1":
      return backflowsSM.backflowS2ToS1(prisma, entryId, actor, { reason });
    case "S3->S1":
      return initiateS3ToS1Backflow(prisma, entryId, actor, { reason });
    case "S3->S2":
      return initiateS3ToS2Backflow(prisma, entryId, actor, { reason });
    case "S4->S1":
      return backflowsSM.backflowS4ToS1(prisma, entryId, actor, { reason });
    case "S4->S2":
      return backflowsSM.backflowS4ToS2(prisma, entryId, actor, { reason });
    case "S4->S3":
      return backflowsSM.backflowS4ToS3(prisma, entryId, actor, { reason });
    case "S5->S1":
      return backflowsSM.backflowS5ToS1(prisma, entryId, actor, { reason });
    case "S7->S2":
      return backflowsSM.backflowS7ToS2(prisma, entryId, actor, { reason });
    case "S7->S3":
      return backflowsSM.backflowS7ToS3(prisma, entryId, actor, { reason });
    default:
      throw new ValidationError(`No re-entry route from ${fromStage} to ${toStage}`);
  }
}

export async function duplicateSegmentIntoNew(
  prisma: PrismaClient,
  input: { entryId: string; fromSegmentNumber: number; toStage: string; actor: Actor; reason: string },
): Promise<SegmentDuplicateOutcome> {
  const { entryId, fromSegmentNumber, toStage, actor } = input;
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("reason is required");
  if (actor.actorLevel === "SYSTEM") throw new ValidationError("SYSTEM cannot duplicate a segment");

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      currentStage: true,
      status: true,
      segmentNumber: true,
      segments: { orderBy: { segmentNumber: "asc" }, select: { id: true, segmentNumber: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");

  const fromStage = String(entry.currentStage);
  const allowed = DUPLICATE_ROUTES[fromStage] ?? [];
  if (!allowed.includes(toStage)) {
    throw new ValidationError(
      allowed.length
        ? `From ${fromStage} a duplicate can open at ${allowed.join(" or ")} — not ${toStage}.`
        : `A segment cannot be duplicated from ${fromStage} (no re-entry route leads back to a configuration stage).`,
    );
  }

  const source = entry.segments.find((s) => s.segmentNumber === fromSegmentNumber);
  if (!source) throw new NotFoundError(`Segment ${fromSegmentNumber} for this entry`);

  // Fail BEFORE the re-entry if there is nothing to carry over — a committed re-entry cannot be
  // undone, so stranding the operator in an empty new segment would be worse than refusing.
  // Mirrors the basis resolution in recallSegmentConfiguration: the configuration in force during
  // the source segment, which may have been inherited from an earlier one.
  const inForceSegmentIds = entry.segments
    .filter((s) => s.segmentNumber <= fromSegmentNumber)
    .map((s) => s.id);
  const sourceConfig = await prisma.availabilityConfiguration.findFirst({
    where: { entryId, segmentId: { in: inForceSegmentIds }, NOT: { optionSelected: { equals: Prisma.DbNull } } },
    orderBy: [{ createdAt: "desc" }],
    select: { id: true },
  });
  if (!sourceConfig) {
    throw new ValidationError(
      `Segment ${fromSegmentNumber} has no chosen room configuration and inherited none from an earlier segment, so there is nothing to base a new segment on.`,
    );
  }

  // 1. The re-entry — this is what creates the new segment (with its own authority gate).
  await runReEntry(prisma, fromStage, toStage, entryId, { actorId: actor.actorId, actorLevel: actor.actorLevel }, reason);
  const newSegmentNumber = Number(entry.segmentNumber ?? 1) + 1;

  // 2. Recall the source segment's basis onto the segment we just opened.
  try {
    const recall = await recallSegmentConfiguration(prisma, {
      entryId,
      fromSegmentNumber,
      actor,
      apply: true,
      reason: `SEGMENT_DUPLICATE: ${reason}`,
    });
    return {
      entryId,
      fromSegmentNumber,
      newSegmentNumber,
      fromStage,
      toStage,
      duplicated: true,
      prefilled: true,
      recall,
      recallBlocked: null,
    };
  } catch (e) {
    // The re-entry already committed. Report the partial outcome instead of failing the whole
    // action — the new segment is real and the operator (or an FOM) can carry the basis over
    // from the segment panel.
    const err = e as AppError;
    return {
      entryId,
      fromSegmentNumber,
      newSegmentNumber,
      fromStage,
      toStage,
      duplicated: true,
      prefilled: false,
      recall: null,
      recallBlocked: {
        code: err?.body?.blockingCondition ?? null,
        message: err?.message ?? "The basis could not be carried over",
        materialChanges: Array.isArray((err?.body?.details as any)?.materialChanges)
          ? ((err.body.details as any).materialChanges as string[])
          : [],
      },
    };
  }
}
