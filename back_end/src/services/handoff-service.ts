import type { PrismaClient } from "@prisma/client";
import { HandoffState, HandoffType } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, StateTransitionError, ValidationError } from "../lib/errors.js";

type ChecklistItem = { code: string; mandatory: boolean };

function configKeyForHandoff(t: HandoffType): string | null {
  if (t === HandoffType.H1) return "handoff.H1.checklist";
  if (t === HandoffType.H2) return "handoff.H2.checklist";
  if (t === HandoffType.H3) return "handoff.H3.checklist";
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

  const config = await prisma.configurationEntry.findUnique({ where: { configKey: key } });
  const items = (config?.value as ChecklistItem[] | undefined) ?? [];
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

  return prisma.handoffRecord.update({
    where: { id: handoffId },
    data: {
      state: HandoffState.ACCEPTED,
      acceptedAt: new Date(),
      acceptedBy: actorId,
    },
  });
}

export async function fulfilHandoff(
  prisma: PrismaClient,
  handoffId: string,
  actorId: string,
  fulfilmentEvidence: Record<string, unknown> | undefined,
) {
  const handoff = await prisma.handoffRecord.findUnique({ where: { id: handoffId } });
  if (!handoff) throw new NotFoundError("Handoff");

  if (handoff.handoffType !== HandoffType.H1) {
    throw new StateTransitionError("fulfil() is only implemented for H1 in this slice");
  }

  if (handoff.state === HandoffState.CREATED) {
    throw new StateTransitionError("H1 cannot move to FULFILLED from CREATED — accept first");
  }

  if (handoff.state !== HandoffState.ACCEPTED) {
    throw new StateTransitionError(`H1 must be in ACCEPTED state to fulfil (current: ${handoff.state})`);
  }

  const ev = fulfilmentEvidence ?? {};
  const requiredKeys = ["roomAssignmentId", "readinessConfirmed", "paymentStatusConfirmed", "ceilingProximityAddressed"];
  for (const key of requiredKeys) {
    if (ev[key] === undefined || ev[key] === null) {
      throw new PolicyGateBlockedError("FULFILMENT_EVIDENCE_INCOMPLETE", `fulfilmentEvidence.${key} is required`);
    }
  }

  if (ev.readinessConfirmed !== true) {
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

  return prisma.handoffRecord.update({
    where: { id: handoffId },
    data: {
      state: HandoffState.REJECTED,
      rejectedAt: new Date(),
      rejectedBy: actorId,
      rejectionReason: rejectionReason.trim(),
    },
  });
}
