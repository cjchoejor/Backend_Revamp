import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState, HandoffType, InventoryClaimState, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, PolicyGateBlockedError, StageGateBlockedError, StateTransitionError, ValidationError } from "../lib/errors.js";
import { requireActiveConfigValue } from "../lib/config-store.js";
import * as disputeGateEngine from "../engines/dispute-gate-engine.js";
import { getTimerEngine } from "./timer-management-service.js";
import { randomUUID } from "node:crypto";

type DbClient = PrismaClient | Prisma.TransactionClient;

async function getEntryWithRoom(db: DbClient, entryId: string) {
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

export async function recordKeyReturn(prisma: PrismaClient, entryId: string, actorId: string, input: { keyCountReturned: number; reconciliationNote?: string }) {
  if (!Number.isInteger(input.keyCountReturned) || input.keyCountReturned < 0) throw new ValidationError("keyCountReturned must be a non-negative integer");
  const { entry, room } = await getEntryWithRoom(prisma, entryId);
  if (entry.currentStage !== Stage.S8) throw new StateTransitionError("Key return is only valid at S8", "NOT_AT_S8");
  const issued = entry.keysIssuedCount ?? 0;
  const reconciled = input.keyCountReturned === issued;
  if (!reconciled && !input.reconciliationNote?.trim()) {
    throw new ValidationError("reconciliationNote is required when keyCountReturned differs from keysIssuedCount");
  }
  return prisma.keyReturnRecord.create({
    data: {
      entryId,
      roomId: room.id,
      receivedBy: actorId,
      returnedAt: new Date(),
      keyCountIssued: issued,
      keyCountReturned: input.keyCountReturned,
      countReconciled: reconciled,
      reconciliationNote: reconciled ? null : input.reconciliationNote?.trim(),
    },
  });
}

export async function recordInspection(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  input: {
    isDeferred: boolean;
    deficientFlagStatus: "RESOLVED" | "UNRESOLVED_AT_CHECKOUT" | "NOT_APPLICABLE";
    deficientConditionId?: string;
    inspectorAssessment?: string;
    damageFound: boolean;
    damageNotes?: string;
  },
) {
  if (typeof input.isDeferred !== "boolean") throw new ValidationError("isDeferred is required");
  if (!input.deficientFlagStatus) throw new ValidationError("deficientFlagStatus is required");
  if (typeof input.damageFound !== "boolean") throw new ValidationError("damageFound is required");
  if (input.damageFound === true && !input.damageNotes?.trim()) throw new ValidationError("damageNotes is required when damageFound = true");
  if (input.deficientFlagStatus !== "NOT_APPLICABLE" && !input.deficientConditionId?.trim()) {
    throw new ValidationError("deficientConditionId is required when deficientFlagStatus is not NOT_APPLICABLE");
  }
  if (input.deficientFlagStatus === "UNRESOLVED_AT_CHECKOUT" && !input.inspectorAssessment?.trim()) {
    throw new ValidationError("inspectorAssessment is required when deficientFlagStatus = UNRESOLVED_AT_CHECKOUT");
  }

  const { entry, room } = await getEntryWithRoom(prisma, entryId);
  if (entry.currentStage !== Stage.S8) throw new StateTransitionError("Room inspection is only valid at S8", "NOT_AT_S8");

  // If there is any active deficient record for the room, NOT_APPLICABLE is forbidden.
  // AC-S7-14: UNRESOLVED at S7 exit becomes DEFICIENT_UNRESOLVED_AT_CHECKOUT at S8 entry.
  const deficient = await prisma.deficientConditionRecord.findFirst({
    where: { roomId: room.id, status: { in: ["UNRESOLVED", "DEFICIENT_UNRESOLVED_AT_CHECKOUT"] } as any },
    orderBy: { detectedAt: "desc" },
  });
  if (deficient && input.deficientFlagStatus === "NOT_APPLICABLE") {
    throw new PolicyGateBlockedError("DEFICIENT_REQUIRES_FLAG_STATUS", "Active DEFICIENT flag exists — inspection must carry final deficient status");
  }

  const seg = await prisma.segment.findFirst({ where: { entryId }, orderBy: { segmentNumber: "desc" } });
  if (!seg) throw new NotFoundError("Segment");

  const created = await prisma.roomInspectionRecord.create({
    data: {
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
    },
  });

  if (input.isDeferred) {
    const windowDays = Number(await requireActiveConfigValue<number>(prisma, "inspection.postCheckout.windowDays"));
    if (!Number.isFinite(windowDays) || windowDays < 1) throw new MissingConfigurationError("inspection.postCheckout.windowDays");
    const dueAt = new Date(Date.now() + windowDays * 86400_000);
    const timerRecordId = randomUUID();
    const engine = await getTimerEngine();
    const pgBossJobId = await engine.schedule("POST_CHECKOUT_INSPECTION_W9", { entryId, timerRecordId }, { startAfter: dueAt });
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

  return created;
}

export async function completeCheckoutPhysicalDeparture(db: DbClient, entryId: string, actorId: string) {
  const prisma = db;
  const { entry, room } = await getEntryWithRoom(prisma, entryId);
  if (entry.currentStage !== Stage.S8) throw new StateTransitionError("Checkout completion is only valid at S8", "NOT_AT_S8");
  if (room.currentClaimState !== InventoryClaimState.OCCUPIED) {
    throw new StateTransitionError("Room must be OCCUPIED to check out", "INVALID_ROOM_STATE_TRANSITION");
  }

  const windowMinutes = Number(await requireActiveConfigValue<number>(prisma as any, "housekeeping.sla.windowMinutes"));
  if (!Number.isFinite(windowMinutes) || windowMinutes < 1) throw new MissingConfigurationError("housekeeping.sla.windowMinutes");

  const now = new Date();
  const dueAt = new Date(now.getTime() + windowMinutes * 60_000);

  await prisma.room.update({ where: { id: room.id }, data: { currentClaimState: InventoryClaimState.DEPARTED_DIRTY } });
  await prisma.roomClaimStateEvent.create({
    data: { roomId: room.id, entryId, fromState: InventoryClaimState.OCCUPIED, toState: InventoryClaimState.DEPARTED_DIRTY, actorId, reason: "S8 checkout completion" },
  });
  const timerRecordId = randomUUID();
  const engine = await getTimerEngine();
  const pgBossJobId = await engine.schedule("HOUSEKEEPING_SLA_W24", { entryId, roomId: room.id, timerRecordId }, { startAfter: dueAt });
  await prisma.timerRecord.create({
    data: {
      id: timerRecordId,
      entryId,
      entityType: "Room",
      entityId: room.id,
      timerType: "HOUSEKEEPING_SLA_W24",
      timerCode: "HOUSEKEEPING_SLA_W24",
      dueAt,
      firesAt: dueAt,
      status: "SCHEDULED",
      pgBossJobId,
      createdBy: actorId,
      payload: { roomId: room.id, entryId, timerRecordId },
    },
  });
  return prisma.room.findUniqueOrThrow({ where: { id: room.id } });
}

export async function ensureDisputeGateClearForS9(prisma: PrismaClient, entryId: string) {
  const gate = await disputeGateEngine.canProgressStage(prisma, entryId, Stage.S9);
  if (gate.result !== "CLEAR") {
    throw new StageGateBlockedError(
      "Dispute gate blocks S8→S9 — disputes must be RESOLVED or CLOSED (no override at this transition)",
      "DISPUTE_GATE_BLOCKED",
    );
  }
}

export async function ensureH4FulfilledOrAuto(prisma: PrismaClient, entryId: string) {
  const h4 = await prisma.handoffRecord.findFirst({ where: { entryId, handoffType: HandoffType.H4 }, orderBy: { createdAt: "desc" } });
  if (!h4) throw new StageGateBlockedError("H4 is required at checkout", "H4_NOT_PRESENT");
  if (h4.isAutoFulfilled) return;
  if (h4.state !== "FULFILLED") throw new StageGateBlockedError("H4 must be fulfilled before S8 exit", "H4_NOT_FULFILLED");
}

export async function buildOrAutoFulfilH5(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true } });
  if (!entry) throw new NotFoundError("Entry");
  const folio = entry.folio;
  if (!folio) throw new NotFoundError("Folio");

  const existing = await prisma.handoffRecord.findFirst({ where: { entryId, handoffType: HandoffType.H5 }, orderBy: { createdAt: "desc" } });
  if (existing) return existing;

  if (folio.state === FolioState.OUTSTANDING) {
    return prisma.handoffRecord.create({
      data: {
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
  const created = await prisma.handoffRecord.create({
    data: {
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

export async function progressStageS8ToS9(prisma: PrismaClient, entryId: string, actorId: string, clientVersion: number | undefined) {
  if (clientVersion == null) throw new ValidationError("version is required");
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true } });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S8) throw new StageGateBlockedError("Entry is not at S8", "NOT_AT_S8");
  if (entry.version !== clientVersion) throw new ValidationError("version mismatch");

  const folio = entry.folio;
  if (!folio) throw new NotFoundError("Folio");
  if (folio.state !== FolioState.SETTLED && folio.state !== FolioState.OUTSTANDING) {
    throw new StageGateBlockedError("Folio must be SETTLED or OUTSTANDING to exit S8", "FOLIO_NOT_SETTLED");
  }

  // Key return must exist (count may be reconciled or governed discrepancy)
  const key = await prisma.keyReturnRecord.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
  if (!key) throw new StageGateBlockedError("Key return not recorded", "KEY_RETURN_NOT_RECORDED");

  // Room must be DEPARTED_DIRTY
  const { room } = await getEntryWithRoom(prisma, entryId);
  if (room.currentClaimState !== InventoryClaimState.DEPARTED_DIRTY) {
    throw new StageGateBlockedError("Room must be DEPARTED_DIRTY before S9", "ROOM_NOT_DEPARTED_DIRTY");
  }

  // Inspection must exist OR deferral timer must exist
  const insp = await prisma.roomInspectionRecord.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } });
  if (!insp) throw new StageGateBlockedError("Room inspection not complete or deferred", "INSPECTION_NOT_COMPLETE_OR_DEFERRED");

  // H4 fulfilled / auto
  await ensureH4FulfilledOrAuto(prisma, entryId);

  // Dispute gate CLEAR (no override at S8->S9)
  await ensureDisputeGateClearForS9(prisma, entryId);

  // H5 created or auto-fulfilled
  const h5 = await buildOrAutoFulfilH5(prisma, entryId, actorId);
  if (!h5) throw new StageGateBlockedError("H5 not created", "H5_NOT_CREATED");

  const now = new Date();
  const s8Dwell = await prisma.stageDwellRecord.findFirst({ where: { entryId, stage: Stage.S8, exitedAt: null }, orderBy: { enteredAt: "desc" } });
  await prisma.$transaction(async (tx) => {
    if (s8Dwell) await tx.stageDwellRecord.update({ where: { id: s8Dwell.id }, data: { exitedAt: now } });
    await tx.stageDwellRecord.create({ data: { entryId, stage: Stage.S9, enteredAt: now } });
    await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S9, version: { increment: 1 }, updatedAt: now } });
  });

  return prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
}

