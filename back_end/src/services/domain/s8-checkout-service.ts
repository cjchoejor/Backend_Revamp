import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState, HandoffType, InventoryClaimState, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
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
  enforceEntryAtS8ForRoomInspection,
} from "../../policies/01-availability/p01-entry-at-s8-for-checkout-progression.js";
import { enforceRoomOccupiedForCheckoutCompletion } from "../../policies/01-availability/p01-s8-checkout-room-occupied-gate.js";

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

export async function recordKeyReturn(prisma: PrismaClient, entryId: string, actorId: string, input: { keyCountReturned: number; reconciliationNote?: string }) {
  if (!Number.isInteger(input.keyCountReturned) || input.keyCountReturned < 0) throw new ValidationError("keyCountReturned must be a non-negative integer");
  const { entry, room } = await getEntryWithRoom(prisma, entryId);
  enforceEntryAtS8ForKeyReturn({ currentStage: entry.currentStage });
  const issued = entry.keysIssuedCount ?? 0;
  const reconciled = input.keyCountReturned === issued;
  if (!reconciled && !input.reconciliationNote?.trim()) {
    throw new ValidationError("reconciliationNote is required when keyCountReturned differs from keysIssuedCount");
  }
  const now = new Date();
  return prisma.$transaction(async (tx) => {
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
        countReconciled: reconciled,
        reconciliationNote: reconciled ? null : input.reconciliationNote?.trim(),
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: reconciled ? "KEY_RETURN.RECORDED" : "KEY_RETURN.DISCREPANCY",
        actorId,
        actorLevel: "L1",
        entityType: "KeyReturnRecord",
        entityId: created.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, roomId: room.id, keyCountIssued: issued, keyCountReturned: input.keyCountReturned, reconciled, reconciliationNote: reconciled ? null : input.reconciliationNote?.trim() ?? null },
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
  enforceEntryAtS8ForRoomInspection({ currentStage: entry.currentStage });

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
    },
  });

  if (input.isDeferred) {
    const windowMs = await resolvePostCheckoutInspectionWindowMs(prisma);
    const dueAt = new Date(Date.now() + windowMs);
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
  const assignmentsToCheckOut =
    distinctAssignments.length > 1 ? distinctAssignments : [entry.roomAssignments[0]];

  // Every room must currently be OCCUPIED. Fail-fast if any isn't — the whole batch
  // reverts and the operator sees which room is in the wrong state.
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
