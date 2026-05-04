import type { PrismaClient } from "@prisma/client";
import { EntryStatus, HandoffState, HandoffType, Stage } from "@prisma/client";
import {
  MissingConfigurationError,
  NotFoundError,
  PolicyGateBlockedError,
  StateTransitionError,
  ValidationError,
} from "../lib/errors.js";
import { requireActiveConfigValue } from "../lib/config-store.js";
import { getTimerEngine } from "./timer-management-service.js";

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
  if (!key) {
    throw new StateTransitionError("Unsupported handoff type for accept");
  }

  if (handoff.handoffType === HandoffType.H1) {
    if (handoff.state !== HandoffState.CREATED) {
      throw new StateTransitionError(`H1 must be in CREATED state to accept (current: ${handoff.state})`);
    }
  } else if (handoff.handoffType === HandoffType.H2 || handoff.handoffType === HandoffType.H3) {
    if (handoff.state !== HandoffState.CREATED) {
      throw new StateTransitionError(`Handoff must be in CREATED state to accept (current: ${handoff.state})`);
    }
  }

  const items = (await requireActiveConfigValue<ChecklistItem[] | undefined>(prisma, key)) ?? [];
  const mandatory = items.filter((i) => i.mandatory);

  if (!checklistCompletion || typeof checklistCompletion !== "object") {
    throw new ValidationError("checklistCompletion object is required");
  }

  for (const item of mandatory) {
    if (!checklistCompletion[item.code]) {
      throw new PolicyGateBlockedError(
        `${handoff.handoffType}_CHECKLIST_INCOMPLETE`,
        `Mandatory checklist item not completed: ${item.code}`,
      );
    }
  }

  const updated = await prisma.handoffRecord.update({
    where: { id: handoffId },
    data: {
      state: HandoffState.ACCEPTED,
      acceptedAt: new Date(),
      acceptedBy: actorId,
    },
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

  if (handoff.handoffType !== HandoffType.H1 && handoff.handoffType !== HandoffType.H4 && handoff.handoffType !== HandoffType.H5) {
    throw new StateTransitionError("fulfil() is only implemented for H1, H4, and H5 in this slice");
  }

  if (handoff.handoffType === HandoffType.H1 && handoff.state === HandoffState.CREATED) {
    throw new StateTransitionError("H1 cannot move to FULFILLED from CREATED — accept first");
  }

  if (handoff.handoffType === HandoffType.H1 && handoff.state !== HandoffState.ACCEPTED) {
    throw new StateTransitionError(`H1 must be in ACCEPTED state to fulfil (current: ${handoff.state})`);
  }
  if (handoff.handoffType === HandoffType.H4 && (handoff.state === HandoffState.REJECTED || handoff.state === HandoffState.CLOSED)) {
    throw new StateTransitionError(`H4 cannot be fulfilled from state ${handoff.state}`);
  }
  if (handoff.handoffType === HandoffType.H5 && (handoff.state === HandoffState.REJECTED || handoff.state === HandoffState.CLOSED)) {
    throw new StateTransitionError(`H5 cannot be fulfilled from state ${handoff.state}`);
  }

  const ev = fulfilmentEvidence ?? {};
  const requiredKeys =
    handoff.handoffType === HandoffType.H4
      ? ["chargesPostedConfirmation", "roomInspectionStatus", "damageAssessmentStatus", "deficientFlagFinalStatus"]
      : handoff.handoffType === HandoffType.H5
        ? ["resolutionBasis"]
        : ["roomAssignmentId", "readinessConfirmed", "paymentStatusConfirmed", "ceilingProximityAddressed"];
  for (const key of requiredKeys) {
    if (ev[key] === undefined || ev[key] === null) {
      throw new PolicyGateBlockedError(
        handoff.handoffType === HandoffType.H4
          ? "H4_FULFILMENT_EVIDENCE_INCOMPLETE"
          : handoff.handoffType === HandoffType.H5
            ? "H5_FULFILMENT_EVIDENCE_INCOMPLETE"
            : "FULFILMENT_EVIDENCE_INCOMPLETE",
        `fulfilmentEvidence.${key} is required`,
      );
    }
  }

  if (handoff.handoffType === HandoffType.H1 && ev.readinessConfirmed !== true) {
    throw new PolicyGateBlockedError("ROOM_NOT_READY", "readinessConfirmed must be true when room is ready");
  }

  return prisma.handoffRecord.update({
    where: { id: handoffId },
    data: {
      state: HandoffState.FULFILLED,
      fulfilledAt: new Date(),
      fulfilledBy: actorId,
      fulfilmentEvidence: ev as object,
    },
  });
}

export async function rejectHandoff(prisma: PrismaClient, handoffId: string, actorId: string, rejectionReason: string) {
  const handoff = await prisma.handoffRecord.findUnique({ where: { id: handoffId } });
  if (!handoff) throw new NotFoundError("Handoff");
  if (handoff.handoffType !== HandoffType.H2 && handoff.handoffType !== HandoffType.H3) {
    throw new StateTransitionError("reject() is only implemented for H2 and H3 in this slice");
  }
  if (!rejectionReason?.trim()) {
    throw new ValidationError("rejectionReason is required");
  }
  if (handoff.state === HandoffState.REJECTED || handoff.state === HandoffState.CLOSED) {
    throw new StateTransitionError(`Cannot reject handoff in state ${handoff.state}`);
  }

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
  if (entry.currentStage !== Stage.S7) throw new StateTransitionError("Entry must be at S7 to initiate H4", "NOT_AT_S7");
  if (entry.status !== EntryStatus.ACTIVE) throw new StateTransitionError("Entry must be ACTIVE to initiate H4");

  const key = configKeyForHandoff(HandoffType.H4);
  if (!key) throw new StateTransitionError("Unsupported handoff type for createH4");
  // S7 readiness: checklist must exist (even if empty list)
  await requireActiveConfigValue<ChecklistItem[] | undefined>(prisma, key);

  const existing = entry.handoffs.find((h) => h.state !== HandoffState.REJECTED && h.state !== HandoffState.CLOSED);
  if (existing) return existing;

  const now = new Date();
  const checkout = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate;
  const isSameDayDeparture = checkout ? checkout.toISOString().slice(0, 10) === now.toISOString().slice(0, 10) : false;
  const shouldAuto = input.autoFulfilForSameDayDeparture === true && isSameDayDeparture;

  const ack = (await requireActiveConfigValue<Record<string, number> | undefined>(prisma, "acknowledgement.windowPerType")) ?? {};
  const h4WindowSeconds = ack.h4 ?? ack.H4 ?? ack.handoffH4 ?? null;
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
  if (entry.currentStage !== Stage.S6 || entry.status !== EntryStatus.ACTIVE) {
    throw new StateTransitionError("createH2 is only available for active entries at S6");
  }

  const room = await prisma.room.findFirst({
    where: { roomNumber: h2Content.roomNumber },
    include: { deficientConditionRecords: { where: { status: "UNRESOLVED" } } },
  });
  if (!room) throw new NotFoundError("Room");
  const isDef = room.isDeficient || (room.deficientConditionRecords?.length ?? 0) > 0;
  if (isDef && (h2Content.deficientConditionStatus == null || !String(h2Content.deficientConditionStatus).trim())) {
    throw new PolicyGateBlockedError("H2_DEFICIENT_INCOMPLETE", "H2 with DEFICIENT room requires deficientConditionStatus");
  }

  const ackWindows = (await requireActiveConfigValue<Record<string, number> | undefined>(prisma, "acknowledgement.windowPerType")) ?? {};
  const h2s = ackWindows.h2 ?? ackWindows.H2 ?? ackWindows.handoffH2;
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
