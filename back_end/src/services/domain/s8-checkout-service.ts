import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState, HandoffType, InventoryClaimState, Stage, type ActorLevel } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { markRoomDirtyOnDepartureTx } from "../../lib/room-claim-state.js";
import { resolvePostCheckoutInspectionWindowMs } from "../../lib/post-checkout-inspection-window.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import * as disputeGateEngine from "../../engines/dispute-gate-engine.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { randomUUID } from "node:crypto";
import { allocateReadableId } from "../../lib/readable-id.js";
import { enforceInspectionCarriesFinalDeficientFlagStatus } from "../../policies/19-deficient-condition/p51-deficient-inspection-review.js";
import { enforceDisputeGateClearForS8ToS9 } from "../../policies/21-service-recovery-dispute/p54-dispute-gate-stage-progression.js";
import { enforceH4FulfilledOrAutoBeforeS8Exit } from "../../policies/25-handoff/p63-handoff-lifecycle-gates.js";
import {
  enforceEntryAtS8ForCheckoutCompletion,
  enforceEntryAtS8ForKeyReturn,
  enforceEntryStageForRoomInspection,
} from "../../policies/01-availability/p01-entry-at-s8-for-checkout-progression.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import {
  readBookingInspectionStanding,
  roomListWords,
  scheduledInspectionTimers,
  type BookingInspectionStanding,
} from "../../lib/room-inspection-standing.js";
import { enforceRoomOccupiedForCheckoutCompletion } from "../../policies/01-availability/p01-s8-checkout-room-occupied-gate.js";
import { countOutstandingKeys } from "./room-key-service.js";
import { resetRoomBedToUsualTx } from "./room-bed-type-service.js";
import { reportDeficiency } from "./deficient-condition-service.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

export async function getEntryWithRoom(db: DbClient, entryId: string) {
  const entry = await db.entry.findUnique({
    where: { id: entryId },
    include: { folio: true, reservation: true, roomAssignments: { orderBy: { createdAt: "desc" }, take: 1 }, handoffs: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  const assignment = entry.roomAssignments[0];
  if (!assignment) throw new ValidationError("Entry has no room assignment");
  const room = await db.room.findUnique({ where: { id: assignment.roomId } });
  if (!room) throw new NotFoundError("Room");
  return { entry, room, assignment };
}

export async function recordKeyReturn(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  input: {
    keyCountReturned: number;
    reconciliationNote?: string;
    returnedRoomIds?: string[];
    keyCountLost?: number;
    lostRoomIds?: string[];
    /** Each lost room with what happened to its key (2026-10-30) — kept on that room's rows. */
    lostRooms?: Array<{ roomId: string; note: string }>;
  },
) {
  if (!Number.isInteger(input.keyCountReturned) || input.keyCountReturned < 0) throw new ValidationError("keyCountReturned must be a non-negative integer");
  const { entry, room } = await getEntryWithRoom(prisma, entryId);
  enforceEntryAtS8ForKeyReturn({ currentStage: entry.currentStage });
  // Keys the guest still HOLDS at checkout (2026-08-14): per-room stamps on the assignment
  // rows — a mid-stay room-change swap already took the vacated room's key back, so it must
  // not be counted again here. Legacy bookings with no stamps fall back to the frozen
  // check-in count (historically equal, since no mid-stay key machinery existed).
  const issued = (await countOutstandingKeys(prisma, entryId)) ?? entry.keysIssuedCount ?? 0;
  // Lost keys (2026-10-26 — the user's 4e36b65, made room-wise): which room's key is lost is a
  // fact, not prose in the note. Room by room when named; a count on a booking keyed by count.
  // A lost room's own reason (2026-10-30, operator: "it should be attached to that room").
  const noteFor = new Map<string, string>();
  for (const r of input.lostRooms ?? []) {
    const n = r.note?.trim();
    if (n) noteFor.set(r.roomId, n);
  }
  const lostRoomIds = [...new Set([...(input.lostRoomIds ?? []), ...(input.lostRooms ?? []).map((r) => r.roomId)])];
  const lost = lostRoomIds.length > 0 ? lostRoomIds.length : input.keyCountLost ?? 0;
  if (!Number.isInteger(lost) || lost < 0) throw new ValidationError("keyCountLost must be a non-negative integer");
  if (lostRoomIds.length > 0 && input.keyCountLost != null && input.keyCountLost !== lostRoomIds.length) {
    throw new ValidationError("keyCountLost must equal the number of rooms named in lostRoomIds");
  }
  if (input.keyCountReturned + lost > issued) {
    throw new ValidationError(`Keys back (${input.keyCountReturned}) and keys lost (${lost}) cannot be more than the ${issued} out with the guest`);
  }
  const reconciled = input.keyCountReturned === issued;
  const note = input.reconciliationNote?.trim();
  // A declared loss with no word of what happened records nothing (SIG-S8 §2.5: the note carries
  // what was lost and any charge assessed). A lost key does NOT hold the booking and posts no
  // charge — there is no price list to charge one against. Room by room, each lost room says its
  // own (2026-10-30); a general note still covers a caller that names no reason per room.
  const unexplained = lostRoomIds.filter((id) => !noteFor.has(id));
  if (lost > 0 && !note && (lostRoomIds.length === 0 || unexplained.length > 0)) {
    throw new ValidationError("Say what happened to the lost key — each lost key needs its reason");
  }
  // Every key out answered — returned, or lost with its reason — needs no other note.
  const accounted = lostRoomIds.length === lost && unexplained.length === 0 && input.keyCountReturned + lost === issued;
  if (!reconciled && !note && !accounted) {
    throw new ValidationError("reconciliationNote is required when keyCountReturned differs from keysIssuedCount");
  }

  // Room-wise return (2026-08-17, operator request — mirrors check-in's issuedKeyRoomIds):
  // each named room must actually have its key out; its assignment rows are stamped returned
  // in the SAME transaction as the KeyReturnRecord, so the ceremony and the per-room truth
  // can never disagree. Count-only callers behave exactly as before.
  const returnedRoomIds = [...new Set(input.returnedRoomIds ?? [])];
  const both = returnedRoomIds.filter((r) => lostRoomIds.includes(r));
  if (both.length > 0) throw new ValidationError("A room's key cannot be both back and lost");
  let rowsToStamp: Array<{ id: string }> = [];
  const lostRowsToStamp: Array<{ id: string; note: string | null }> = [];
  const lostWords: Array<{ roomId: string; roomNumber: string; note: string | null }> = [];
  if (lostRoomIds.length > 0) {
    const lostRows = await prisma.roomAssignment.findMany({
      where: { entryId, roomId: { in: lostRoomIds } },
      include: { room: { select: { roomNumber: true } } },
    });
    for (const rid of lostRoomIds) {
      const rs = lostRows.filter((r) => r.roomId === rid);
      if (rs.length === 0) throw new ValidationError("lostRoomIds contains a room that is not part of this booking");
      const outstanding = rs.filter((r) => r.keyIssuedAt && !r.keyReturnedAt && !r.keyLostAt);
      if (outstanding.length === 0) throw new ValidationError(`Room ${rs[0].room.roomNumber} has no key out to lose`);
      const why = noteFor.get(rid) ?? note ?? null;
      lostRowsToStamp.push(...outstanding.map((r) => ({ id: r.id, note: why })));
      lostWords.push({ roomId: rid, roomNumber: rs[0].room.roomNumber, note: why });
    }
  }
  if (returnedRoomIds.length > 0) {
    const keyRows = await prisma.roomAssignment.findMany({
      where: { entryId, roomId: { in: returnedRoomIds } },
      include: { room: { select: { roomNumber: true } } },
    });
    for (const rid of returnedRoomIds) {
      const rs = keyRows.filter((r) => r.roomId === rid);
      if (rs.length === 0) throw new ValidationError(`returnedRoomIds contains a room that is not part of this booking`);
      const outstanding = rs.filter((r) => r.keyIssuedAt && !r.keyReturnedAt && !r.keyLostAt);
      if (outstanding.length === 0) {
        throw new ValidationError(`Room ${rs[0].room.roomNumber} has no key out to return`);
      }
      rowsToStamp.push(...outstanding.map((r) => ({ id: r.id })));
    }
  }

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    // Per-row updates — the db.ts guard forbids roomAssignment.updateMany wholesale.
    for (const r of rowsToStamp) {
      await tx.roomAssignment.update({
        where: { id: r.id },
        data: { keyReturnedAt: now, keyReturnedBy: actorId },
      });
    }
    for (const r of lostRowsToStamp) {
      await tx.roomAssignment.update({
        where: { id: r.id },
        data: { keyLostAt: now, keyLostBy: actorId, keyLostNote: r.note },
      });
    }
    // The record's note: the desk's own words, else each lost room with its reason.
    const recordNote =
      note || (lostWords.length ? lostWords.map((w) => `Room ${w.roomNumber}: ${w.note ?? "lost"}`).join(" · ") : undefined);
    const keyReturnId = await allocateReadableId(tx, "KEY_RETURN" as const, now);
    const created = await tx.keyReturnRecord.create({
      data: {
        id: keyReturnId,
        entryId,
        roomId: room.id,
        receivedBy: actorId,
        returnedAt: now,
        keyCountIssued: issued,
        keyCountReturned: input.keyCountReturned,
        keyCountLost: lost,
        lostRoomIds,
        countReconciled: reconciled,
        // A note explaining a loss is kept even when the counts happen to reconcile.
        reconciliationNote: reconciled && lost === 0 ? null : recordNote ?? null,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: lost > 0 ? "KEY_RETURN.KEYS_LOST" : reconciled ? "KEY_RETURN.RECORDED" : "KEY_RETURN.DISCREPANCY",
        actorId,
        actorLevel: "L1",
        entityType: "KeyReturnRecord",
        entityId: created.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, roomId: room.id, keyCountIssued: issued, keyCountReturned: input.keyCountReturned, keyCountLost: lost, reconciled, reconciliationNote: reconciled && lost === 0 ? null : recordNote ?? null, returnedRoomIds: returnedRoomIds.length > 0 ? returnedRoomIds : null, lostRoomIds: lostRoomIds.length > 0 ? lostRoomIds : null, lostRooms: lostWords.length ? lostWords : null },
        createdBy: actorId,
      },
    });
    return created;
  });
}

export async function recordInspection(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  input: {
    /** The room inspected (2026-10-26 — one inspection per room). Optional when the booking
     *  leaves a single room at check-out. */
    roomId?: string;
    isDeferred: boolean;
    deficientFlagStatus: "RESOLVED" | "UNRESOLVED_AT_CHECKOUT" | "NOT_APPLICABLE";
    deficientConditionId?: string;
    inspectorAssessment?: string;
    damageFound: boolean;
    damageNotes?: string;
    /** A damage found stops the room being sold — a fault report is raised (2026-10-26, asked each time). */
    damageStopsSale?: boolean;
    damageFaultCategory?: "HOUSEKEEPING" | "MAINTENANCE" | "SOFT_FURNISHING" | "OTHER";
  },
  opts?: {
    actorLevel?: ActorLevel;
    /** The booking's standing, read once by the bulk act (each room is independent of the others). */
    precomputedStanding?: BookingInspectionStanding;
  },
) {
  if (typeof input.isDeferred !== "boolean") throw new ValidationError("isDeferred is required");
  if (!input.deficientFlagStatus) throw new ValidationError("deficientFlagStatus is required");
  if (typeof input.damageFound !== "boolean") throw new ValidationError("damageFound is required");
  if (input.damageFound === true && !input.damageNotes?.trim()) throw new ValidationError("Say what the damage is");
  // Asked each time (2026-10-26, operator ruling): a damage may or may not stop the room being sold.
  if (input.damageFound === true && !input.isDeferred && typeof input.damageStopsSale !== "boolean") {
    throw new ValidationError("Say whether the damage stops the room being sold");
  }
  if (input.deficientFlagStatus !== "NOT_APPLICABLE" && !input.deficientConditionId?.trim()) {
    throw new ValidationError("deficientConditionId is required when deficientFlagStatus is not NOT_APPLICABLE");
  }
  if (input.deficientFlagStatus === "UNRESOLVED_AT_CHECKOUT" && !input.inspectorAssessment?.trim()) {
    throw new ValidationError("inspectorAssessment is required when deficientFlagStatus = UNRESOLVED_AT_CHECKOUT");
  }

  const { entry } = await getEntryWithRoom(prisma, entryId);
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  // The step first (not at Check-out or Closed / a put-off at Closed), before the room is chosen.
  enforceEntryStageForRoomInspection({ currentStage: entry.currentStage, isDeferred: input.isDeferred, inspectionOwed: true });

  // ONE INSPECTION PER ROOM (2026-10-26): the room is named, and it must be one the guest leaves at
  // check-out. A booking with a single such room may leave it unnamed. At S9 an inspection is
  // still taken for a room that owes one — put off at check-out, or (a booking that left Check-out
  // before rooms were inspected one by one) never recorded — and never put off again.
  const standing = opts?.precomputedStanding ?? (await readBookingInspectionStanding(prisma, entryId));
  const atS9 = entry.currentStage === Stage.S9;
  const owes = (r: (typeof standing.rooms)[number]) => r.standing.state === "PUT_OFF" || r.standing.state === "NOT_RECORDED";
  const candidates = atS9 ? standing.rooms.filter(owes) : standing.rooms;
  let row: (typeof standing.rooms)[number] | undefined;
  if (input.roomId) {
    row = standing.rooms.find((r) => r.roomId === input.roomId);
    if (!row) {
      throw new ValidationError(
        `That room is not one this booking leaves at check-out — the rooms inspected are ${roomListWords(standing.rooms.map((r) => r.roomNumber)) || "none"}`,
      );
    }
  } else if (candidates.length === 1) {
    row = candidates[0];
  } else if (candidates.length > 1) {
    throw new ValidationError(
      `This booking has ${candidates.length} rooms to inspect (${roomListWords(candidates.map((r) => r.roomNumber))}) — name the room inspected`,
    );
  }
  enforceEntryStageForRoomInspection({
    currentStage: entry.currentStage,
    isDeferred: input.isDeferred,
    inspectionOwed: !!row && owes(row),
    roomNumber: row?.roomNumber ?? null,
  });
  if (!row) throw new ValidationError("This booking has no room to inspect");
  const room = await prisma.room.findUnique({ where: { id: row.roomId } });
  if (!room) throw new NotFoundError("Room");
  // A damage already charged or waived stands: inspecting the room again would leave that charge,
  // or that waiver, with no damage on record behind it (2026-10-26).
  const prior = row.standing.inspection;
  if (prior?.damageAnswer === "CHARGED" || prior?.damageAnswer === "WAIVED") {
    throw new ValidationError(
      `Room ${room.roomNumber}'s damage was already ${prior.damageAnswer === "CHARGED" ? "charged" : "waived"} — its inspection stands; a charge is put right on the bill`,
    );
  }
  const completing = atS9 && row.standing.state === "PUT_OFF" ? row.standing.inspection : null;

  // If there is any active deficient record for the room, NOT_APPLICABLE is forbidden.
  // AC-S7-14: UNRESOLVED at S7 exit becomes DEFICIENT_UNRESOLVED_AT_CHECKOUT at S8 entry.
  const deficient = await prisma.deficientConditionRecord.findFirst({
    where: { roomId: room.id, status: { in: ["UNRESOLVED", "DEFICIENT_UNRESOLVED_AT_CHECKOUT"] } as any },
    orderBy: { detectedAt: "desc" },
  });
  enforceInspectionCarriesFinalDeficientFlagStatus({
    hasActiveDeficientCondition: !!deficient,
    deficientFlagStatus: input.deficientFlagStatus,
  });

  const seg = await prisma.segment.findFirst({ where: { entryId }, orderBy: { segmentNumber: "desc" } });
  if (!seg) throw new NotFoundError("Segment");

  // The damage stops the room being sold: report the fault — the room leaves service now, and the
  // inspection records which report it raised (2026-10-26).
  let damageFaultId: string | null = null;
  if (input.damageFound && !input.isDeferred && input.damageStopsSale === true) {
    const fault = await reportDeficiency(
      prisma,
      { roomId: room.id },
      { category: input.damageFaultCategory ?? "MAINTENANCE", description: `Damage found at the inspection — ${input.damageNotes!.trim()}` },
      { actorId, actorLevel: (opts?.actorLevel === "SYSTEM" ? "L1" : opts?.actorLevel ?? "L1") as "L1" | "L2" | "L3" | "L4" },
    );
    damageFaultId = fault.id;
  }

  const inspectionId = await allocateReadableId(prisma, "ROOM_INSPECTION" as const);
  const created = await prisma.roomInspectionRecord.create({
    data: {
      id: inspectionId,
      entryId,
      roomId: room.id,
      segmentId: seg.id,
      inspectedBy: actorId,
      inspectedAt: new Date(),
      isDeferred: input.isDeferred,
      deficientFlagStatus: input.deficientFlagStatus,
      deficientConditionId: input.deficientFlagStatus === "NOT_APPLICABLE" ? null : input.deficientConditionId,
      inspectorAssessment: input.inspectorAssessment?.trim() ?? null,
      damageFound: input.damageFound,
      damageNotes: input.damageFound ? input.damageNotes?.trim() : null,
      damageFaultId,
    },
  });

  // One clock per room: a newer record of the room — put off again, or inspected — replaces the
  // room's own clock and leaves every other room's alone.
  const priorClocks = await scheduledInspectionTimers(prisma, entryId, room.id);
  if (priorClocks.length) {
    const engine = await getTimerEngine();
    await Promise.all(priorClocks.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
    await prisma.timerRecord.updateMany({
      where: { id: { in: priorClocks.map((t) => t.id) }, status: "SCHEDULED" },
      data: {
        status: "CANCELLED",
        cancelledAt: new Date(),
        cancelledBy: actorId,
        cancelledReason: input.isDeferred ? `Room ${room.roomNumber}'s inspection put off again` : `Room ${room.roomNumber} inspected`,
      },
    });
  }

  if (input.isDeferred) {
    const windowMs = await resolvePostCheckoutInspectionWindowMs(prisma);
    const dueAt = new Date(Date.now() + windowMs);
    const timerRecordId = randomUUID();
    const engine = await getTimerEngine();
    const pgBossJobId = await engine.schedule("POST_CHECKOUT_INSPECTION_W9", { entryId, timerRecordId, roomId: room.id }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerRecordId,
        entryId,
        entityType: "Entry",
        entityId: entryId,
        timerType: "POST_CHECKOUT_INSPECTION_W9",
        timerCode: "POST_CHECKOUT_INSPECTION_W9",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId,
        createdBy: actorId,
        payload: { roomId: room.id },
      },
    });
  }

  if (atS9) {
    // Recorded under the event name SIG-S8 §595 gives the completion of a put-off inspection; the
    // room's clock was stopped above (the W9 worker also finds the room's newest record
    // non-deferred and skips on its own).
    await prisma.traceEvent.create({
      data: {
        eventType: "POST_CHECKOUT_INSPECTION.INSPECTION_COMPLETED",
        actorId,
        actorLevel: opts?.actorLevel ?? "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: new Date(),
        stageContext: Stage.S9,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          inspectionId: created.id,
          deferredInspectionId: completing?.id ?? null,
          // A room the booking left Check-out without an inspection for (before 2026-10-26).
          recordedAfterDepartureWithoutPutOff: !completing,
          roomId: room.id,
          roomNumber: room.roomNumber,
          deficientFlagStatus: created.deficientFlagStatus,
          damageFound: created.damageFound,
        },
        createdBy: actorId,
      },
    });
  }

  return created;
}

/**
 * Every room still to inspect, in one act (2026-10-26, operator: a booking can have more than 20
 * rooms). CLEAR records "nothing found" — no fault, no damage — for each; PUT_OFF puts each off to
 * after departure (Check-out only). Deliberately partial and vocal: a room with an open fault
 * report is skipped and named (its fault must be answered on its own), a room already inspected
 * or put off is left as recorded, and a room that refuses is named with the refusal. Each room is
 * recorded through `recordInspection`, so every rule of the single act holds for each.
 */
export async function recordInspectionsInBulk(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  input: { mode: "CLEAR" | "PUT_OFF"; roomIds?: string[] },
  opts?: { actorLevel?: ActorLevel },
) {
  const { entry } = await getEntryWithRoom(prisma, entryId);
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  const putOff = input.mode === "PUT_OFF";
  enforceEntryStageForRoomInspection({ currentStage: entry.currentStage, isDeferred: putOff, inspectionOwed: true });
  const atS9 = entry.currentStage === Stage.S9;

  const standing = await readBookingInspectionStanding(prisma, entryId);
  if (input.roomIds?.length) {
    const unknown = input.roomIds.filter((id) => !standing.rooms.some((r) => r.roomId === id));
    if (unknown.length) {
      throw new ValidationError(
        `Not a room this booking leaves at check-out — the rooms inspected are ${roomListWords(standing.rooms.map((r) => r.roomNumber))}`,
      );
    }
  }
  const named = input.roomIds?.length ? new Set(input.roomIds) : null;
  // At Check-out a bulk act never overwrites a room already recorded; at Closed it finishes the
  // rooms that still owe one.
  const owes = (s: string) => (atS9 ? s === "PUT_OFF" || s === "NOT_RECORDED" : s === "NOT_RECORDED");
  const candidates = standing.rooms.filter((r) => owes(r.standing.state) && (!named || named.has(r.roomId)));
  if (!candidates.length) {
    throw new ValidationError(
      atS9 ? "No room is waiting for an inspection" : "Every room is already inspected or put off — record one again on its own",
    );
  }

  const recorded: Array<{ roomId: string; roomNumber: string }> = [];
  const skipped: Array<{ roomId: string; roomNumber: string; reason: "OPEN_FAULT" | "REFUSED"; message: string }> = [];
  for (const r of candidates) {
    const fault = await prisma.deficientConditionRecord.findFirst({
      where: { roomId: r.roomId, status: { in: ["UNRESOLVED", "DEFICIENT_UNRESOLVED_AT_CHECKOUT"] } as any },
      select: { id: true },
    });
    if (fault) {
      skipped.push({ roomId: r.roomId, roomNumber: r.roomNumber, reason: "OPEN_FAULT", message: `Room ${r.roomNumber} has an open fault — answer it on its own` });
      continue;
    }
    try {
      await recordInspection(
        prisma,
        entryId,
        actorId,
        { roomId: r.roomId, isDeferred: putOff, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false },
        { actorLevel: opts?.actorLevel, precomputedStanding: standing },
      );
      recorded.push({ roomId: r.roomId, roomNumber: r.roomNumber });
    } catch (e) {
      skipped.push({
        roomId: r.roomId,
        roomNumber: r.roomNumber,
        reason: "REFUSED",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  await prisma.traceEvent.create({
    data: {
      eventType: "ROOM_INSPECTION.RECORDED_IN_BULK",
      actorId,
      actorLevel: opts?.actorLevel ?? "L1",
      entityType: "Entry",
      entityId: entryId,
      operation: "CREATE",
      timestamp: new Date(),
      stageContext: entry.currentStage,
      inquiryId: entry.inquiryId,
      entryId,
      payload: {
        mode: input.mode,
        recordedRooms: recorded.map((r) => r.roomNumber),
        skippedRooms: skipped.map((s) => ({ roomNumber: s.roomNumber, reason: s.reason })),
      },
      createdBy: actorId,
    },
  });
  return { mode: input.mode, recorded, skipped };
}

export async function completeCheckoutPhysicalDeparture(db: DbClient, entryId: string, actorId: string) {
  const prisma = db;
  // Load ALL room assignments (not just the latest) so group entries with multiple rooms
  // depart together. For non-group entries there's one assignment and behaviour is
  // unchanged. Mirror of the S6 batched check-in refactor.
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { folio: true, reservation: true, roomAssignments: { orderBy: { createdAt: "desc" }, include: { room: true } } },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.roomAssignments.length === 0) throw new ValidationError("Entry has no room assignment");
  enforceEntryAtS8ForCheckoutCompletion({ currentStage: entry.currentStage });

  // Batching rule: whenever the entry has multiple distinct room assignments, check out
  // all of them together. Historically this keyed on groupBillingMode === "GROUP_MASTER",
  // but that missed multi-room bookings below the group threshold. Dedup by roomId so
  // a room-change history doesn't double-process the same room.
  const distinctAssignments = (() => {
    const seen = new Set<string>();
    const list: typeof entry.roomAssignments = [];
    for (const a of entry.roomAssignments) {
      if (seen.has(a.roomId)) continue;
      seen.add(a.roomId);
      list.push(a);
    }
    return list;
  })();
  const allAssignments =
    distinctAssignments.length > 1 ? distinctAssignments : [entry.roomAssignments[0]];

  // Rooms the guest already left — a mid-stay room change end-dates the old room and marks
  // it DEPARTED_DIRTY at the swap (2026-08-17: the old fail-fast demanded OCCUPIED on EVERY
  // room, so any booking with an S7 in-place change could never physically check out). Also
  // makes the call idempotent: a second whole-folio partial settlement finds nothing to do.
  const alreadyDeparted = new Set(["DEPARTED_DIRTY", "DEPARTED_CLEAN"]);
  const assignmentsToCheckOut = allAssignments.filter((a) => !alreadyDeparted.has(String(a.room.currentClaimState)));
  if (assignmentsToCheckOut.length === 0) return { alreadyDeparted: true } as const;

  // Every room still being checked out must be OCCUPIED. Fail-fast if any is in some OTHER
  // state — the whole batch reverts and the operator sees which room is wrong.
  for (const a of assignmentsToCheckOut) {
    enforceRoomOccupiedForCheckoutCompletion({ currentClaimState: a.room.currentClaimState });
  }

  const windowMinutes = Number(await requireActiveConfigValue<number>(prisma as any, "housekeeping.sla.windowMinutes"));
  if (!Number.isFinite(windowMinutes) || windowMinutes < 1) throw new MissingConfigurationError("housekeeping.sla.windowMinutes");

  const now = new Date();
  const dueAt = new Date(now.getTime() + windowMinutes * 60_000);
  const engine = await getTimerEngine();

  // For each room: OCCUPIED → DEPARTED_DIRTY + audit event + housekeeping SLA timer.
  // Atomicity: DB writes wrapped in a single $transaction so a mid-loop failure rolls back
  // ALL room state changes. If we're already inside a transaction (nested caller), reuse it —
  // Prisma doesn't support nested $transaction. Pg-boss jobs are scheduled AFTER the tx
  // commits so a rollback never leaves orphan jobs firing.
  const runInTx = async (tx: Prisma.TransactionClient): Promise<string[]> => {
    const ids: string[] = [];
    for (const a of assignmentsToCheckOut) {
      await tx.room.update({ where: { id: a.room.id }, data: { currentClaimState: InventoryClaimState.DEPARTED_DIRTY } });
      await markRoomDirtyOnDepartureTx(tx, a.room.id);
      await tx.roomClaimStateEvent.create({
        data: {
          roomId: a.room.id,
          entryId,
          fromState: InventoryClaimState.OCCUPIED,
          toState: InventoryClaimState.DEPARTED_DIRTY,
          actorId,
          reason: "S8 checkout completion",
        },
      });
      // The guest has left: the room goes back to its usual bed setup (2026-09-19).
      await resetRoomBedToUsualTx(tx, {
        roomId: a.room.id,
        entryId,
        actorId,
        reason: "Checked out",
        leaving: true,
        now,
      });
      ids.push(a.room.id);
    }
    return ids;
  };
  const updatedRoomIds =
    "$transaction" in prisma
      ? await (prisma as PrismaClient).$transaction(runInTx)
      : await runInTx(prisma as Prisma.TransactionClient);

  // Post-commit: schedule the housekeeping SLA timer for each room. Any partial failure here
  // is idempotent-safe on retry — the room states are already durably DEPARTED_DIRTY, and a
  // caller retry will attempt to schedule again for the still-missing timers only.
  for (const roomId of updatedRoomIds) {
    const timerRecordId = randomUUID();
    const pgBossJobId = await engine.schedule("HOUSEKEEPING_SLA_W24", { entryId, roomId, timerRecordId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerRecordId,
        entryId,
        entityType: "Room",
        entityId: roomId,
        timerType: "HOUSEKEEPING_SLA_W24",
        timerCode: "HOUSEKEEPING_SLA_W24",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId,
        createdBy: actorId,
        payload: { roomId, entryId, timerRecordId },
      },
    });
  }

  // Legacy return: single room for non-group entries (preserves the existing signature that
  // callers rely on). For groups we return the first — callers rendering N rooms should
  // fetch the fresh assignments list instead of relying on the return value.
  return prisma.room.findUniqueOrThrow({ where: { id: updatedRoomIds[0] } });
}

export async function ensureDisputeGateClearForS9(prisma: PrismaClient, entryId: string) {
  const gate = await disputeGateEngine.canProgressStage(prisma, entryId, Stage.S9);
  enforceDisputeGateClearForS8ToS9({ gateResult: gate.result });
}

export async function ensureH4FulfilledOrAuto(prisma: PrismaClient, entryId: string) {
  const h4 = await prisma.handoffRecord.findFirst({ where: { entryId, handoffType: HandoffType.H4 }, orderBy: { createdAt: "desc" } });
  enforceH4FulfilledOrAutoBeforeS8Exit({ h4 });
}

export async function buildOrAutoFulfilH5(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true } });
  if (!entry) throw new NotFoundError("Entry");
  const folio = entry.folio;
  if (!folio) throw new NotFoundError("Folio");

  const existing = await prisma.handoffRecord.findFirst({ where: { entryId, handoffType: HandoffType.H5 }, orderBy: { createdAt: "desc" } });
  if (existing) return existing;

  if (folio.state === FolioState.OUTSTANDING) {
    const h5Id = await allocateReadableId(prisma, "HANDOFF" as const);
    return prisma.handoffRecord.create({
      data: {
        id: h5Id,
        entryId,
        handoffType: HandoffType.H5,
        state: "CREATED",
        fromRole: "FRONT_DESK",
        fromActorId: actorId,
        toRole: "FINANCE",
        checklistContent: { outstandingBalance: folio.outstandingBalance.toString(), basis: "Checkout governed outstanding" },
        createdBy: actorId,
        stageContext: Stage.S8,
        isAutoFulfilled: false,
      },
    });
  }

  // SETTLED with no residual obligations → auto fulfil
  const now = new Date();
  const h5AutoId = await allocateReadableId(prisma, "HANDOFF" as const, now);
  const created = await prisma.handoffRecord.create({
    data: {
      id: h5AutoId,
      entryId,
      handoffType: HandoffType.H5,
      state: "FULFILLED",
      fromRole: "SYSTEM",
      fromActorId: "system",
      toRole: "FINANCE",
      checklistContent: { autoFulfilled: true },
      createdBy: "system",
      stageContext: Stage.S8,
      isAutoFulfilled: true,
      fulfilledAt: now,
      fulfilledBy: "system",
    },
  });
  await prisma.traceEvent.create({
    data: {
      eventType: "HANDOFF.AUTO_FULFILLED",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "HandoffRecord",
      entityId: created.id,
      operation: "TRANSITION",
      timestamp: now,
      stageContext: Stage.S8,
      inquiryId: entry.inquiryId,
      entryId,
      payload: { handoffId: created.id, entryId, handoffType: "H5" },
      createdBy: "SYSTEM",
    },
  });
  return created;
}
