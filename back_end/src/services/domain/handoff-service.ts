import type { Prisma, PrismaClient } from "@prisma/client";
import { HandoffState, HandoffType, Stage } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";
import { enforceDeficientCarryIntoH2 } from "../../policies/19-deficient-condition/p49-deficient-carry-into-h2.js";
import { enforceHandoffFulfilmentEvidence, enforceMandatoryChecklistItemsCompleted } from "../../policies/25-handoff/p63-handoff-lifecycle-gates.js";
import {
  enforceHandoffAcceptTypeSupported,
  enforceHandoffConfigKeyPresentForH4,
  enforceHandoffFulfilStateH1,
  enforceHandoffFulfilStateH4,
  enforceHandoffFulfilStateH5,
  enforceHandoffFulfilTypeSupported,
  enforceHandoffInCreatedStateForAccept,
  enforceHandoffRejectTypeSupported,
  enforceHandoffRejectableState,
} from "../../policies/25-handoff/p63-handoff-service-state-guards.js";
import {
  enforceEntryActiveForH4Initiation,
  enforceEntryAtS6AndActiveForCreateH2,
  enforceEntryAtS7ForH4Initiation,
} from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";

type ChecklistItem = { code: string; mandatory: boolean };

function configKeyForHandoff(t: HandoffType): string | null {
  if (t === HandoffType.H1) return "handoff.H1.checklist";
  if (t === HandoffType.H2) return "handoff.H2.checklist";
  if (t === HandoffType.H3) return "handoff.H3.checklist";
  if (t === HandoffType.H4) return "handoff.H4.checklist";
  return null;
}

export async function acceptHandoff(
  prisma: PrismaClient,
  handoffId: string,
  actorId: string,
  checklistCompletion: Record<string, boolean> | undefined,
) {
  const handoff = await prisma.handoffRecord.findUnique({ where: { id: handoffId } });
  if (!handoff) throw new NotFoundError("Handoff");

  const key = configKeyForHandoff(handoff.handoffType);
  enforceHandoffAcceptTypeSupported(key);
  enforceHandoffInCreatedStateForAccept({ handoffType: handoff.handoffType, state: handoff.state });

  const items = (await requireActiveConfigValue<ChecklistItem[] | undefined>(prisma, key)) ?? [];
  const mandatory = items.filter((i) => i.mandatory);

  enforceMandatoryChecklistItemsCompleted({
    handoffType: handoff.handoffType,
    mandatoryItemCodes: mandatory.map((i) => i.code),
    checklistCompletion,
  });

  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.handoffRecord.update({
      where: { id: handoffId },
      data: { state: HandoffState.ACCEPTED, acceptedAt: now, acceptedBy: actorId },
    });
    await tx.traceEvent.create({
      data: {
        eventType: `HANDOFF.${u.handoffType}_ACCEPTED`,
        actorId,
        actorLevel: "L1",
        entityType: "HandoffRecord",
        entityId: handoffId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: u.stageContext,
        inquiryId: null,
        entryId: u.entryId,
        payload: { handoffId, entryId: u.entryId, type: u.handoffType },
        createdBy: actorId,
      },
    });
    return u;
  });

  // SIG-S6: cancel W25 acceptance timer when H2/H3 accepted.
  if (handoff.handoffType === HandoffType.H2 || handoff.handoffType === HandoffType.H3) {
    const timers = await prisma.timerRecord.findMany({
      where: { entityType: "HandoffRecord", entityId: handoffId, timerCode: "H2_H3_ACCEPTANCE_W25", status: "SCHEDULED" },
      orderBy: { createdAt: "desc" },
      take: 10,
    });
    const engine = await getTimerEngine();
    for (const t of timers) {
      if (t.pgBossJobId) await engine.cancel(t.pgBossJobId);
    }
    await prisma.timerRecord.updateMany({
      where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelledBy: actorId, cancelledReason: "Handoff accepted" },
    });
  }

  return updated;
}

export async function fulfilHandoff(
  prisma: PrismaClient,
  handoffId: string,
  actorId: string,
  fulfilmentEvidence: Record<string, unknown> | undefined,
) {
  const handoff = await prisma.handoffRecord.findUnique({ where: { id: handoffId } });
  if (!handoff) throw new NotFoundError("Handoff");

  const handoffType = handoff.handoffType;
  enforceHandoffFulfilTypeSupported(handoffType);
  enforceHandoffFulfilStateH1({ handoffType, state: handoff.state });
  enforceHandoffFulfilStateH4({ handoffType, state: handoff.state });
  enforceHandoffFulfilStateH5({ handoffType, state: handoff.state });

  const ev = fulfilmentEvidence ?? {};
  const enforcedEvidence = enforceHandoffFulfilmentEvidence({
    handoffType,
    fulfilmentEvidence: ev,
  });

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const u = await tx.handoffRecord.update({
      where: { id: handoffId },
      data: {
        state: HandoffState.FULFILLED,
        fulfilledAt: now,
        fulfilledBy: actorId,
        fulfilmentEvidence: enforcedEvidence as object,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: `HANDOFF.${u.handoffType}_FULFILLED`,
        actorId,
        actorLevel: "L1",
        entityType: "HandoffRecord",
        entityId: handoffId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: u.stageContext,
        inquiryId: null,
        entryId: u.entryId,
        payload: { handoffId, entryId: u.entryId, type: u.handoffType },
        createdBy: actorId,
      },
    });
    return u;
  });
}

export async function rejectHandoff(prisma: PrismaClient, handoffId: string, actorId: string, rejectionReason: string) {
  const handoff = await prisma.handoffRecord.findUnique({ where: { id: handoffId } });
  if (!handoff) throw new NotFoundError("Handoff");
  enforceHandoffRejectTypeSupported({ handoffType: handoff.handoffType });
  if (!rejectionReason?.trim()) {
    throw new ValidationError("rejectionReason is required");
  }
  enforceHandoffRejectableState({ state: handoff.state });

  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const updated = await tx.handoffRecord.update({
      where: { id: handoffId },
      data: {
        state: HandoffState.REJECTED,
        rejectedAt: now,
        rejectedBy: actorId,
        rejectionReason: rejectionReason.trim(),
      },
    });
    // AC-S6-020: FOM / routing (no silent rejection)
    await tx.traceEvent.create({
      data: {
        eventType: "HANDOFF.REJECT_FOM_NOTIFIED",
        actorId,
        actorLevel: "L1",
        entityType: "HandoffRecord",
        entityId: handoffId,
        operation: "ALERT",
        timestamp: now,
        stageContext: handoff.stageContext,
        inquiryId: null,
        entryId: handoff.entryId,
        payload: { handoffId, entryId: handoff.entryId, type: handoff.handoffType, reason: rejectionReason.trim() },
        createdBy: actorId,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "HANDOFF.FOM_ROUTING_EVENT",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "HandoffRecord",
        entityId: handoffId,
        operation: "ALERT",
        timestamp: now,
        stageContext: handoff.stageContext,
        inquiryId: null,
        entryId: handoff.entryId,
        payload: { handoffId, toRole: "FOM" },
        createdBy: "SYSTEM",
      },
    });
    return updated;
  });
}

/** AC-S7-15/16 — Create H4 (pre-checkout coordination). Same-day departures can be auto-fulfilled. */
export async function createH4(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  input: { autoFulfilForSameDayDeparture?: boolean; notes?: string } = {},
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { reservation: true, handoffs: { where: { handoffType: HandoffType.H4 }, orderBy: { createdAt: "desc" }, take: 5 } },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS7ForH4Initiation({ currentStage: entry.currentStage });
  enforceEntryActiveForH4Initiation({ status: entry.status });

  const key = configKeyForHandoff(HandoffType.H4);
  enforceHandoffConfigKeyPresentForH4(key);
  // S7 readiness: checklist must exist (even if empty list)
  await requireActiveConfigValue<ChecklistItem[] | undefined>(prisma, key);

  const existing = entry.handoffs.find((h) => h.state !== HandoffState.REJECTED && h.state !== HandoffState.CLOSED);
  if (existing) return existing;

  const now = new Date();
  const checkout = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate;
  const isSameDayDeparture = checkout ? checkout.toISOString().slice(0, 10) === now.toISOString().slice(0, 10) : false;
  const shouldAuto = input.autoFulfilForSameDayDeparture === true && isSameDayDeparture;

  // Policy registry override: `registry.handoffAck.seconds.h4Seconds` (when enabled) overrides
  // the legacy `acknowledgement.windowPerType.h4` sub-key.
  const handoffAckPolicy = await getRegistryPolicy(prisma, "registry.handoffAck.seconds");
  const registryH4 =
    handoffAckPolicy && handoffAckPolicy.enabled !== false && typeof handoffAckPolicy.h4Seconds === "number"
      ? (handoffAckPolicy.h4Seconds as number)
      : null;
  const ack = registryH4 === null ? ((await requireActiveConfigValue<Record<string, number> | undefined>(prisma, "acknowledgement.windowPerType")) ?? {}) : {};
  const h4WindowSeconds = registryH4 ?? ack.h4 ?? ack.H4 ?? ack.handoffH4 ?? null;
  const slaDeadlineAt = h4WindowSeconds == null ? null : new Date(now.getTime() + Number(h4WindowSeconds) * 1000);

  return prisma.$transaction(async (tx) => {
    const created = await tx.handoffRecord.create({
      data: {
        entryId,
        handoffType: HandoffType.H4,
        state: shouldAuto ? HandoffState.FULFILLED : HandoffState.CREATED,
        fromRole: "FRONT_DESK",
        fromActorId: actorId,
        toRole: "HOUSEKEEPING",
        checklistContent: { notes: input.notes ?? null } as object,
        fulfilmentEvidence: shouldAuto
          ? ({ autoFulfilled: true, basis: "SAME_DAY_DEPARTURE" } as object)
          : undefined,
        fulfilledAt: shouldAuto ? now : null,
        fulfilledBy: shouldAuto ? "SYSTEM" : null,
        slaDeadlineAt: slaDeadlineAt ?? undefined,
        isAutoFulfilled: shouldAuto,
        createdBy: actorId,
        stageContext: Stage.S7,
      } as any,
    });

    if (shouldAuto) {
      await (tx as any).traceEvent.create({
        data: {
          eventType: "HANDOFF.H4_AUTO_FULFILLED",
          actorId: "SYSTEM",
          actorLevel: "SYSTEM",
          entityType: "HandoffRecord",
          entityId: created.id,
          operation: "TRANSITION",
          timestamp: now,
          stageContext: Stage.S7,
          inquiryId: entry.inquiryId,
          entryId,
          payload: { handoffId: created.id, entryId, basis: "SAME_DAY_DEPARTURE" },
          createdBy: "SYSTEM",
        },
      });
    }

    // best-effort W25 acceptance timer for H4 if not auto-fulfilled and SLA exists
    if (!shouldAuto && created.slaDeadlineAt) {
      const engine = await getTimerEngine();
      const jobId = await engine.schedule("H4_ACCEPTANCE_W25", { handoffId: created.id }, { startAfter: created.slaDeadlineAt });
      await (tx as any).timerRecord.create({
        data: {
          entryId,
          entityType: "HandoffRecord",
          entityId: created.id,
          timerType: "H4_ACCEPTANCE_W25",
          timerCode: "H4_ACCEPTANCE_W25",
          stageContext: Stage.S7,
          firesAt: created.slaDeadlineAt,
          dueAt: created.slaDeadlineAt,
          status: "SCHEDULED",
          payload: { handoffId: created.id, entryId },
          pgBossJobId: jobId,
          createdBy: "SYSTEM",
        },
      });
    }

    return created;
  });
}

/** AC-S6-016 / AC-S6-035 — S6 H2 (must carry deficient status when room is DEFICIENT; ack config required for SLA + W25). */
export async function createH2(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  h2Content: {
    roomNumber: string;
    guestProfileId?: string | null;
    deficientConditionStatus: string | null;
    specialHousekeepingRequests?: unknown;
  },
) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS6AndActiveForCreateH2({ currentStage: entry.currentStage, status: entry.status });

  const room = await prisma.room.findFirst({
    where: { roomNumber: h2Content.roomNumber },
    include: { deficientConditionRecords: { where: { status: "UNRESOLVED" } } },
  });
  if (!room) throw new NotFoundError("Room");
  const isDef = room.isDeficient || (room.deficientConditionRecords?.length ?? 0) > 0;
  enforceDeficientCarryIntoH2({
    isRoomDeficient: isDef,
    deficientConditionStatus: h2Content.deficientConditionStatus,
  });

  // Policy registry override: `registry.handoffAck.seconds.h2Seconds` (when enabled) overrides
  // the legacy `acknowledgement.windowPerType.h2` sub-key.
  const h2Policy = await getRegistryPolicy(prisma, "registry.handoffAck.seconds");
  const registryH2 =
    h2Policy && h2Policy.enabled !== false && typeof h2Policy.h2Seconds === "number"
      ? (h2Policy.h2Seconds as number)
      : null;
  const ackWindows = registryH2 === null ? ((await requireActiveConfigValue<Record<string, number> | undefined>(prisma, "acknowledgement.windowPerType")) ?? {}) : {};
  const h2s = registryH2 ?? ackWindows.h2 ?? ackWindows.H2 ?? ackWindows.handoffH2;
  if (h2s == null) {
    throw new MissingConfigurationError("acknowledgement.windowPerType");
  }
  const sla = new Date(Date.now() + Number(h2s) * 1000);
  const created = await prisma.handoffRecord.create({
    data: {
      entryId,
      handoffType: HandoffType.H2,
      state: HandoffState.CREATED,
      fromRole: "FRONT_DESK",
      fromActorId: actorId,
      toRole: "HOUSEKEEPING",
      checklistContent: h2Content as object,
      deficientConditionStatus: h2Content.deficientConditionStatus,
      createdBy: actorId,
      stageContext: Stage.S6,
      slaDeadlineAt: sla,
    },
  });

  const engine = await getTimerEngine();
  const existingTimer = await prisma.timerRecord.findFirst({
    where: { entityType: "HandoffRecord", entityId: created.id, timerCode: "H2_H3_ACCEPTANCE_W25", status: "SCHEDULED" },
  });
  if (!existingTimer) {
    const jobId = await engine.schedule("H2_H3_ACCEPTANCE_W25", { handoffId: created.id }, { startAfter: created.slaDeadlineAt! });
    await prisma.timerRecord.create({
      data: {
        entryId,
        entityType: "HandoffRecord",
        entityId: created.id,
        timerType: "H2_H3_ACCEPTANCE_W25",
        timerCode: "H2_H3_ACCEPTANCE_W25",
        stageContext: Stage.S6,
        firesAt: created.slaDeadlineAt!,
        dueAt: created.slaDeadlineAt!,
        status: "SCHEDULED",
        payload: { handoffId: created.id, entryId },
        pgBossJobId: jobId,
        createdBy: "SYSTEM",
      },
    });
  }

  return created;
}

/** SIG-S4 D-01 — H1 created inside the confirmation transaction (`stageContext` **S4**). */
export async function createH1AtS4ConfirmationTx(
  tx: Prisma.TransactionClient,
  input: { entryId: string; actorId: string; checklistContent: unknown; isAutoFulfilled?: boolean },
) {
  return tx.handoffRecord.create({
    data: {
      entryId: input.entryId,
      handoffType: HandoffType.H1,
      state: HandoffState.CREATED,
      fromRole: "RESERVATIONS",
      fromActorId: input.actorId,
      toRole: "FRONT_DESK",
      checklistContent: (input.checklistContent ?? {}) as object,
      createdBy: input.actorId,
      stageContext: Stage.S4,
      isAutoFulfilled: input.isAutoFulfilled === true,
    },
  });
}
