import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceDisputeClosureReasonPresent } from "../../policies/21-service-recovery-dispute/p55-dispute-closure.js";
import * as disputeGateEngine from "../../engines/dispute-gate-engine.js";
import { cancelDisputeSlaW27Timers, scheduleDisputeSlaW27Timers } from "../../lib/schedule-dispute-sla-w27.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { enforceDisputeGateOverrideTargetAllowed } from "../../policies/21-service-recovery-dispute/p54-dispute-gate-stage-progression.js";
import { allocateReadableId } from "../../lib/readable-id.js";

/**
 * The dispute's own history on the booking (2026-09-18). Raising, reviewing, resolving and
 * closing a dispute wrote no event at all — the booking's history never said a guest had queried
 * a charge, nor what the GM answered. Best-effort: the act has already committed.
 */
async function writeDisputeTrace(
  prisma: PrismaClient,
  eventType: string,
  d: { id: string; entryId: string; title: string },
  actorId: string,
  actorLevel: string | undefined,
  extra?: Record<string, unknown>,
) {
  await prisma.traceEvent
    .create({
      data: {
        eventType,
        actorId,
        actorLevel: (actorLevel ?? "L1") as any,
        entityType: "DisputeRecord",
        entityId: d.id,
        operation: "UPDATE",
        timestamp: new Date(),
        entryId: d.entryId,
        payload: { disputeId: d.id, title: d.title, ...(extra ?? {}) },
        createdBy: actorId,
      } as any,
    })
    .catch(() => {});
}

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
  actorLevel?: string,
) {
  if (!input.entryId?.trim()) throw new ValidationError("entryId is required");
  if (!input.folioId?.trim()) throw new ValidationError("folioId is required");
  if (!input.title?.trim()) throw new ValidationError("title is required");

  const folio = await prisma.folio.findUnique({ where: { id: input.folioId } });
  if (!folio) throw new NotFoundError("Folio");
  if (folio.entryId !== input.entryId) throw new ValidationError("Folio does not belong to this entry");

  const disputeId = await allocateReadableId(prisma, "DISPUTE" as const);
  const created = await prisma.disputeRecord.create({
    data: {
      id: disputeId,
      entryId: input.entryId,
      folioId: input.folioId,
      title: input.title,
      description: input.description,
      openedBy: actorId,
    },
  });
  await writeDisputeTrace(prisma, "DISPUTE.OPENED", created, actorId, actorLevel, { description: created.description ?? null });
  // Dispute SLA timers are load-bearing (SIG-S7 governance). Was silently swallowed —
  // a DB or config-store blip left the dispute open with no first-response / resolution clock.
  // Now: log the underlying error to a TraceEvent so the operator sees the SLA is at risk,
  // but still let the dispute row commit (dispute open must not be blocked by a pg-boss hiccup).
  try {
    await scheduleDisputeSlaW27Timers(prisma, {
      disputeId: created.id,
      entryId: created.entryId,
      actorId,
      openedAt: created.openedAt,
    });
  } catch (e) {
    await prisma.traceEvent.create({
      data: {
        eventType: "DISPUTE.SLA_TIMER_SCHEDULE_FAILED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "DisputeRecord",
        entityId: created.id,
        operation: "ALERT",
        timestamp: new Date(),
        payload: { disputeId: created.id, entryId: created.entryId, error: (e as Error)?.message ?? String(e) },
        createdBy: "SYSTEM",
      } as any,
    }).catch(() => {
      // If trace write itself fails we surrender — the dispute is already open and we can't
      // do anything useful here without corrupting the flow.
    });
  }
  return created;
}

export async function closeDispute(
  prisma: PrismaClient,
  disputeId: string,
  actorId: string,
  input: { closureReason: string },
  actorLevel?: string,
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
  const closed = await prisma.disputeRecord.update({
    where: { id: disputeId },
    data: { status: "CLOSED", closedAt: now, closedBy: actorId, closureReason: input.closureReason, updatedBy: actorId },
  });
  await writeDisputeTrace(prisma, "DISPUTE.CLOSED", closed, actorId, actorLevel, { reason: input.closureReason });
  return closed;
}

export async function progressDispute(
  prisma: PrismaClient,
  disputeId: string,
  actorId: string,
  input: { status: "IN_PROGRESS" | "RESOLVED" },
  actorLevel?: string,
) {
  const d = await prisma.disputeRecord.findUnique({ where: { id: disputeId } });
  if (!d) throw new NotFoundError("DisputeRecord");
  if (d.status === "CLOSED") throw new ValidationError("Dispute is already closed");

  if (input.status === "IN_PROGRESS") {
    if (d.status !== "OPEN" && d.status !== "REOPENED") {
      throw new ValidationError("Dispute can only move to IN_PROGRESS from OPEN or REOPENED");
    }
    const reviewing = await prisma.disputeRecord.update({
      where: { id: disputeId },
      data: { status: "IN_PROGRESS", updatedBy: actorId },
    });
    await writeDisputeTrace(prisma, "DISPUTE.REVIEW_STARTED", reviewing, actorId, actorLevel);
    return reviewing;
  }

  if (d.status === "RESOLVED") return d;
  const updated = await prisma.disputeRecord.update({
    where: { id: disputeId },
    data: { status: "RESOLVED", updatedBy: actorId },
  });
  await writeDisputeTrace(prisma, "DISPUTE.RESOLVED", updated, actorId, actorLevel);
  try {
    await cancelDisputeSlaW27Timers(prisma, disputeId, actorId, "DISPUTE_RESOLVED");
  } catch (e) {
    // Surface the failure via TraceEvent — a silent swallow left SLA timers firing against
    // RESOLVED disputes as false alarms. Dispute update itself has already committed above.
    await prisma.traceEvent.create({
      data: {
        eventType: "DISPUTE.SLA_TIMER_CANCEL_FAILED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "DisputeRecord",
        entityId: disputeId,
        operation: "ALERT",
        timestamp: new Date(),
        payload: { disputeId, reason: "DISPUTE_RESOLVED", error: (e as Error)?.message ?? String(e) },
        createdBy: "SYSTEM",
      } as any,
    }).catch(() => {});
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
  // Silent swallow previously let the gate-override abuse monitor skip scheduling; log to a
  // trace so an operator can see when override monitoring drops.
  try {
    const engine = await getTimerEngine();
    await engine.schedule("FOM_OVERRIDE_FREQUENCY_W32", { now: new Date() }, { startAfter: new Date() });
  } catch (e) {
    await prisma.traceEvent.create({
      data: {
        eventType: "DISPUTE.GATE_OVERRIDE_MONITOR_SCHEDULE_FAILED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "DisputeGateOverrideRecord",
        entityId: created.id,
        operation: "ALERT",
        timestamp: new Date(),
        payload: { overrideId: created.id, disputeId, error: (e as Error)?.message ?? String(e) },
        createdBy: "SYSTEM",
      } as any,
    }).catch(() => {});
  }
  return created;
}

export async function canProgressToS8(prisma: PrismaClient, entryId: string): Promise<"CLEAR" | "BLOCKED_WITH_OVERRIDE_AVAILABLE" | "BLOCKED"> {
  const gate = await disputeGateEngine.canProgressStage(prisma, entryId, Stage.S8);
  return gate.result;
}

