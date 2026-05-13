import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceDisputeClosureReasonPresent } from "../../policies/21-service-recovery-dispute/p55-dispute-closure.js";
import * as disputeGateEngine from "../../engines/dispute-gate-engine.js";
import { cancelDisputeSlaW27Timers, scheduleDisputeSlaW27Timers } from "../../lib/schedule-dispute-sla-w27.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { enforceDisputeGateOverrideTargetAllowed } from "../../policies/21-service-recovery-dispute/p54-dispute-gate-stage-progression.js";

export async function getDispute(prisma: PrismaClient, disputeId: string) {
  const d = await prisma.disputeRecord.findUnique({
    where: { id: disputeId },
    include: {
      entry: { select: { id: true, currentStage: true, status: true } },
      folio: { select: { id: true, state: true, outstandingBalance: true } },
      gateOverrides: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!d) throw new NotFoundError("DisputeRecord");
  return d;
}

export async function openDispute(
  prisma: PrismaClient,
  actorId: string,
  input: { entryId: string; folioId: string; title: string; description?: string },
) {
  if (!input.entryId?.trim()) throw new ValidationError("entryId is required");
  if (!input.folioId?.trim()) throw new ValidationError("folioId is required");
  if (!input.title?.trim()) throw new ValidationError("title is required");

  const folio = await prisma.folio.findUnique({ where: { id: input.folioId } });
  if (!folio) throw new NotFoundError("Folio");
  if (folio.entryId !== input.entryId) throw new ValidationError("Folio does not belong to this entry");

  const created = await prisma.disputeRecord.create({
    data: {
      entryId: input.entryId,
      folioId: input.folioId,
      title: input.title,
      description: input.description,
      openedBy: actorId,
    },
  });
  try {
    await scheduleDisputeSlaW27Timers(prisma, {
      disputeId: created.id,
      entryId: created.entryId,
      actorId,
      openedAt: created.openedAt,
    });
  } catch {
    // W27 registration is best-effort; dispute open must succeed without pg-boss.
  }
  return created;
}

export async function closeDispute(
  prisma: PrismaClient,
  disputeId: string,
  actorId: string,
  input: { closureReason: string },
) {
  enforceDisputeClosureReasonPresent({ closureReason: input.closureReason });
  const existing = await prisma.disputeRecord.findUnique({ where: { id: disputeId } });
  if (!existing) throw new NotFoundError("DisputeRecord");
  if (existing.status === "CLOSED") throw new ValidationError("Dispute is already closed");
  const now = new Date();
  try {
    await cancelDisputeSlaW27Timers(prisma, disputeId, actorId, "DISPUTE_CLOSED");
  } catch {
    // Timer cancellation is best-effort; dispute close must still commit.
  }
  return prisma.disputeRecord.update({
    where: { id: disputeId },
    data: { status: "CLOSED", closedAt: now, closedBy: actorId, closureReason: input.closureReason, updatedBy: actorId },
  });
}

export async function progressDispute(
  prisma: PrismaClient,
  disputeId: string,
  actorId: string,
  input: { status: "IN_PROGRESS" | "RESOLVED" },
) {
  const d = await prisma.disputeRecord.findUnique({ where: { id: disputeId } });
  if (!d) throw new NotFoundError("DisputeRecord");
  if (d.status === "CLOSED") throw new ValidationError("Dispute is already closed");

  if (input.status === "IN_PROGRESS") {
    if (d.status !== "OPEN" && d.status !== "REOPENED") {
      throw new ValidationError("Dispute can only move to IN_PROGRESS from OPEN or REOPENED");
    }
    return prisma.disputeRecord.update({
      where: { id: disputeId },
      data: { status: "IN_PROGRESS", updatedBy: actorId },
    });
  }

  if (d.status === "RESOLVED") return d;
  const updated = await prisma.disputeRecord.update({
    where: { id: disputeId },
    data: { status: "RESOLVED", updatedBy: actorId },
  });
  try {
    await cancelDisputeSlaW27Timers(prisma, disputeId, actorId, "DISPUTE_RESOLVED");
  } catch {
    // Best-effort.
  }
  return updated;
}

export async function createGateOverride(
  prisma: PrismaClient,
  disputeId: string,
  actorId: string,
  input: { targetStage: Stage; freeTextReason: string },
) {
  if (!input.freeTextReason?.trim()) throw new ValidationError("freeTextReason is required");
  enforceDisputeGateOverrideTargetAllowed({ targetStage: input.targetStage === Stage.S9 ? "S9" : "S8" });
  const created = await prisma.disputeGateOverrideRecord.create({
    data: { disputeId, targetStage: input.targetStage, freeTextReason: input.freeTextReason, createdBy: actorId },
  });
  // Cross-stage escalation monitor (docs: W32; code: existing worker implementation).
  try {
    const engine = await getTimerEngine();
    await engine.schedule("FOM_OVERRIDE_FREQUENCY_W32", { now: new Date() }, { startAfter: new Date() });
  } catch {
    // Best-effort.
  }
  return created;
}

export async function canProgressToS8(prisma: PrismaClient, entryId: string): Promise<"CLEAR" | "BLOCKED_WITH_OVERRIDE_AVAILABLE" | "BLOCKED"> {
  const gate = await disputeGateEngine.canProgressStage(prisma, entryId, Stage.S8);
  return gate.result;
}

