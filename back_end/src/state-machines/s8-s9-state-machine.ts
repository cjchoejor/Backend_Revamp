import type { Prisma, PrismaClient } from "@prisma/client";
import { HandoffState, HandoffType, Stage } from "@prisma/client";
import { getTimerEngine } from "../services/infrastructure/timer-management-service.js";
import { NotFoundError, StageGatesBlockedError, StateTransitionError, ValidationError } from "../lib/errors.js";
import { collectS8ToS9ReadOnlyFailures } from "../lib/collect-s8-to-s9-read-failures.js";
import { enforceFolioStateAllowsS8ToS9Progression } from "../policies/13-billing-model/p33-folio-state-allows-s8-to-s9-progression.js";
import { enforceH5PresentForS8ToS9 } from "../policies/25-handoff/p63-handoff-lifecycle-gates.js";
import { enforceEntryAtS8ForS8ToS9Progression } from "../policies/01-availability/p01-entry-at-s8-for-checkout-progression.js";
import { enforceEntryActiveForStageTransition } from "../policies/01-availability/p01-entry-progression-stage-gates.js";
import { schedulePaymentFollowUpW8IfOutstanding } from "../lib/schedule-payment-followup-w8.js";
import { buildOrAutoFulfilH5 } from "../services/domain/s8-checkout-service.js";
import { loadEntryDetail } from "../lib/entry-detail-include.js";

/**
 * What a finished stay still had ticking, retired as the booking reaches Closed (2026-09-18).
 *
 * Nothing did it, so a sealed booking's rail kept counting down — a quote's validity (one clock per
 * version the booking ever had: four on one test booking), the reply windows of papers sent before
 * arrival, the arrival handoffs a re-entry left open, and the kitchen's and housekeeping's acceptance
 * of handoffs raised at check-in. A guest
 * who left within the hour of arriving got the FOM alerted, after they had gone, that the kitchen
 * had not accepted their stay. What stays running is what still has work after the stay: the tax
 * invoice's reply window, housekeeping's cleaning, the inspection window, payment follow-up.
 */
async function retireStayLeftoversTx(tx: Prisma.TransactionClient, input: { entryId: string; actorId: string; now: Date }) {
  const { entryId, actorId, now } = input;
  const open = await tx.handoffRecord.findMany({
    where: {
      entryId,
      // H1 (the arrival handoff) too: a re-entry mints a fresh one and can leave the old open.
      handoffType: { in: [HandoffType.H1, HandoffType.H2, HandoffType.H3] },
      state: { in: [HandoffState.CREATED, HandoffState.ACCEPTED, HandoffState.ESCALATED] },
    },
    select: { id: true },
  });
  const handoffIds = open.map((h) => h.id);
  if (handoffIds.length > 0) {
    await tx.handoffRecord.updateMany({
      where: { id: { in: handoffIds } },
      data: { state: HandoffState.CANCELLED, cancelledAt: now, cancelledBy: actorId, cancelledReason: "GUEST_CHECKED_OUT" },
    });
  }
  // The reply windows that still matter after the stay: the tax invoice's.
  const keepComms = await tx.communicationRecord.findMany({
    where: { entryId, commType: "FINAL_INVOICE" },
    select: { id: true },
  });
  const timers = await tx.timerRecord.findMany({
    where: {
      entryId,
      status: "SCHEDULED",
      OR: [
        { timerCode: { in: ["QUOTATION_VALIDITY_W15", "NIGHT_AUDIT_STAY_NIGHT_W37", "H2_H3_ACCEPTANCE_W25"] } },
        { entityType: "HandoffRecord", entityId: { in: handoffIds } },
        { timerCode: "ACKNOWLEDGEMENT_WINDOW_W22", NOT: { entityId: { in: keepComms.map((c) => c.id) } } },
      ],
    },
    select: { id: true, pgBossJobId: true, timerCode: true },
  });
  if (timers.length > 0) {
    await tx.timerRecord.updateMany({
      where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
      data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "Stay over — moved to Closed" } as never,
    });
  }
  return {
    handoffsCancelled: handoffIds.length,
    timersCancelled: timers.map((t) => t.timerCode),
    jobIds: timers.map((t) => t.pgBossJobId).filter((j): j is string => !!j),
  };
}

export async function progressStageS8ToS9(prisma: PrismaClient, entryId: string, actorId: string, clientVersion: number | undefined) {
  if (clientVersion == null) throw new ValidationError("version is required");
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true, reservation: true } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS8ForS8ToS9Progression({ currentStage: entry.currentStage });
  enforceEntryActiveForStageTransition({ status: entry.status });
  if (entry.version !== clientVersion) {
    throw new StateTransitionError("Entry version mismatch — refresh and retry", "OPTIMISTIC_LOCK_VERSION_MISMATCH");
  }

  const folio = entry.folio;
  if (!folio) throw new NotFoundError("Folio");
  enforceFolioStateAllowsS8ToS9Progression({ folioState: folio.state });

  const failures = await collectS8ToS9ReadOnlyFailures(prisma, { entryId, entry });
  if (failures.length) {
    throw new StageGatesBlockedError(failures);
  }

  const h5 = await buildOrAutoFulfilH5(prisma, entryId, actorId);
  enforceH5PresentForS8ToS9({ h5 });

  const now = new Date();
  const s8Dwell = await prisma.stageDwellRecord.findFirst({ where: { entryId, stage: Stage.S8, exitedAt: null }, orderBy: { enteredAt: "desc" } });
  const retired = await prisma.$transaction(async (tx) => {
    if (s8Dwell) await tx.stageDwellRecord.update({ where: { id: s8Dwell.id }, data: { exitedAt: now } });
    await tx.stageDwellRecord.create({ data: { entryId, stage: Stage.S9, enteredAt: now } });
    await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S9, version: { increment: 1 }, updatedAt: now } });
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.STAGE_TRANSITION",
        actorId,
        actorLevel: "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S9,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, fromStage: "S8", toStage: "S9", h5State: h5?.state ?? null, folioState: folio.state },
        createdBy: actorId,
      },
    });
    await schedulePaymentFollowUpW8IfOutstanding(tx, {
      entryId,
      folioId: folio.id,
      folioState: folio.state,
      outstandingBalance: folio.outstandingBalance,
    });
    return retireStayLeftoversTx(tx, { entryId, actorId, now });
  });
  // The pg-boss jobs behind the retired clocks, after the commit — best-effort; every worker
  // re-checks the booking before acting.
  if (retired.jobIds.length > 0) {
    try {
      const engine = await getTimerEngine();
      await Promise.all(retired.jobIds.map((j) => engine.cancel(j).catch(() => undefined)));
    } catch {
      // best-effort
    }
  }

  return loadEntryDetail(prisma, entryId);
}
