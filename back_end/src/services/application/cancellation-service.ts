import type { PrismaClient } from "@prisma/client";
import { ActorLevel, EntryStatus, FolioLineType, FolioState, HoldState, InventoryClaimState, Stage } from "@prisma/client";
import { NotFoundError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { enforceEntryAtS3ForS3CancellationRoute, enforceEntryAtS5ForS5CancellationRoute, enforceEntryAtS7ForPostCheckInEarlyDepartureCancellation } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import {
  capCancellationPenaltyAtAdvancePayment,
  computePostCheckInEarlyDeparturePenalty,
  computeS5PreArrivalCancellationPenalty,
  enforceFolioPresentForS5CancellationPolicy35,
  enforceReservationPresentForS5CancellationPolicy35,
  sumAdvancePaymentInTotalForFolio,
  type CancellationPolicyTiersConfig,
} from "../../policies/14-cancellation/p35-cancellation-penalty-from-commitment.js";
import { enforceGmAuthorityForCancellationPenaltyWaiver } from "../../policies/14-cancellation/p35-penalty-waiver-requires-gm-authority.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import type { ActorLevel as RequestActorLevel } from "../../types/actor.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { allocateReadableId } from "../../lib/readable-id.js";

/**
 * SIG-S3 §6.5 — pre-confirmation cancellation at S3: release the committed hold, cancel timers,
 * supersede any in-flight proforma invoices, compute a penalty per the *disclosed* terms (no
 * frozen reservation exists yet at S3), refund the net advance, and transition entry to terminal.
 *
 * Authority: L1 (FRONT_DESK) minimum per SIG-S3 line 129. GM authority required only when the
 * caller asks to waive the penalty.
 */
export async function cancelEntryAtS3(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  opts?: { reason?: string; penaltyWaiverRequested?: boolean; actorLevel?: RequestActorLevel },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      folio: { include: { invoices: true } },
      committedHold: true,
      cancellationDisclosure: true,
      inquiry: true,
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.status === EntryStatus.CANCELLED) {
    throw new ValidationError("Entry is already cancelled");
  }
  if (entry.status !== EntryStatus.ACTIVE) {
    throw new StateTransitionError("Cancellation is only supported for ACTIVE entries");
  }

  enforceEntryAtS3ForS3CancellationRoute({ currentStage: entry.currentStage });

  const folio = entry.folio;
  if (!folio) throw new ValidationError("No folio on the entry — S3 cancellation requires a folio");

  const now = new Date();
  const checkInDate = entry.checkInDate ?? new Date(now.getTime() + 86400_000);

  const waiver = opts?.penaltyWaiverRequested === true;
  if (waiver && !opts?.actorLevel) {
    throw new ValidationError("actorLevel is required when penaltyWaiverRequested is true");
  }
  if (opts?.actorLevel) {
    enforceGmAuthorityForCancellationPenaltyWaiver({
      penaltyWaiverRequested: waiver,
      actorLevel: opts.actorLevel,
    });
  }
  const traceActorLevel = (opts?.actorLevel ?? "L1") as ActorLevel;

  const advanceTotal = await sumAdvancePaymentInTotalForFolio(prisma, folio.id);

  // S3 source of truth for cancellation terms: the disclosure record signed before the hold was
  // placed (per §6.5 — disclosure is a precondition for hold placement). Falls back to the
  // configured policy tiers when no disclosure terms are available (defensive).
  const disclosedTerms =
    (entry.cancellationDisclosure?.disclosedTerms as Record<string, unknown>) ?? {};
  const policyTiers = await requireActiveConfigValue<CancellationPolicyTiersConfig>(prisma, "cancellation.policyTiers").catch(
    () => null as CancellationPolicyTiersConfig | null,
  );

  // The S5 pre-arrival penalty function operates on (now, checkInDate, terms, tiers) — same shape
  // as S3. Reused intentionally; the math is identical because nothing has been frozen yet.
  const { rawPenalty, hoursUntilCheckIn } = computeS5PreArrivalCancellationPenalty({
    now,
    checkInDate,
    frozenCancellationTerms: disclosedTerms,
    policyTiers,
  });
  const cappedPenalty = capCancellationPenaltyAtAdvancePayment(rawPenalty, advanceTotal);
  const penalty = waiver ? 0 : cappedPenalty;
  const netRefund = advanceTotal - penalty;

  const timers = await prisma.timerRecord.findMany({
    where: { entryId, status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
    take: 50,
  });

  const updated = await prisma.$transaction(async (tx) => {
    // 1. Penalty line (only if non-zero).
    if (penalty > 0) {
      await tx.folioLine.create({
        data: {
          folioId: folio.id,
          lineType: FolioLineType.SERVICE,
          description: "S3 pre-confirmation cancellation penalty",
          amount: penalty,
          currency: "BTN",
          chargeDate: now,
          stage: Stage.S3,
          postedBy: actorId,
        },
      });
    }

    // 2. Refund obligation (only if net refund > 0).
    if (netRefund > 0) {
      const refundId = await allocateReadableId(tx, "PAYMENT" as const, now);
      await tx.paymentRecord.create({
        data: {
          id: refundId,
          folioId: folio.id,
          entryId,
          amount: netRefund,
          paymentDirection: "OUT",
          recordedBy: actorId,
          stage: Stage.S3,
          notes: "Refund obligation after S3 cancellation",
        },
      });
    }

    // 3. Supersede any non-terminal PI invoices on this folio (SIG-S3 §3.3 — terminal events
    //    supersede in-flight invoices). Invoice has no supersededAt timestamp field; the
    //    state change + TraceEvent below carry the timestamp.
    const nonTerminalInvoiceIds = folio.invoices
      .filter((i) => i.state === "DRAFT" || i.state === "DISPATCHED")
      .map((i) => i.id);
    if (nonTerminalInvoiceIds.length > 0) {
      await tx.invoice.updateMany({
        where: { id: { in: nonTerminalInvoiceIds } },
        data: { state: "SUPERSEDED" },
      });
    }

    // 4. Release the committed hold, return inventory to FREE.
    const hold = entry.committedHold;
    if (hold && hold.state !== HoldState.RELEASED && hold.state !== HoldState.EXPIRED) {
      if (hold.roomId) {
        const room = await tx.room.findUnique({ where: { id: hold.roomId } });
        const fromState = room?.currentClaimState;
        if (fromState && fromState !== InventoryClaimState.FREE) {
          await tx.room.update({
            where: { id: hold.roomId },
            data: { currentClaimState: InventoryClaimState.FREE },
          });
          await tx.roomClaimStateEvent.create({
            data: {
              roomId: hold.roomId,
              entryId,
              fromState,
              toState: InventoryClaimState.FREE,
              actorId,
              reason: "S3_PRE_CONFIRMATION_CANCELLATION",
              effectiveFrom: now,
            },
          });
        }
      }
      await tx.committedHold.update({
        where: { id: hold.id },
        data: {
          state: HoldState.RELEASED,
          releasedAt: now,
          releasedBy: actorId,
          releaseReason: "S3_PRE_CONFIRMATION_CANCELLATION",
        },
      });
    }

    // 5. Cancel all scheduled timers tied to this entry (W3, W22, W34, dwell monitors, etc.).
    if (timers.length > 0) {
      await tx.timerRecord.updateMany({
        where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
        data: {
          status: "CANCELLED",
          cancelledAt: now,
          cancelledBy: actorId,
          cancelledReason: "S3 entry cancelled",
        } as any,
      });
    }

    // 6. Folio close-out: PROVISIONAL → SETTLED so it stops accepting new charges (no CANCELLED
    //    state in the FolioState enum). The Entry being CANCELLED is the terminal marker;
    //    SETTLED on the folio just means "no further activity expected".
    await tx.folio.update({
      where: { id: folio.id },
      data: { state: FolioState.SETTLED, closedAt: now, closedBy: actorId } as any,
    });

    // 7. Audit trace.
    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.S3.CANCELLED",
        actorId,
        actorLevel: traceActorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S3,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          reason: opts?.reason ?? null,
          penalty,
          cappedPenalty,
          rawPenalty,
          advanceTotal,
          netRefund,
          hoursUntilCheckIn,
          penaltyWaiverRequested: waiver,
        },
        createdBy: actorId,
      },
    });

    await recomputeFolioOutstandingBalance(tx, folio.id);

    // 8. Terminal entry state.
    return tx.entry.update({
      where: { id: entryId },
      data: {
        status: EntryStatus.CANCELLED,
        currentStage: Stage.TERMINAL,
        closedAt: now,
        closedBy: actorId,
        version: { increment: 1 },
      },
    });
  });

  // Fire-and-forget pg-boss job cancellation (best-effort; timer records are already CANCELLED in
  // the DB so a missed pg-boss cancel just means the job runs and the worker sees the dead record).
  Promise.resolve().then(async () => {
    try {
      const engine = await getTimerEngine();
      await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
    } catch {
      // best-effort
    }
  });

  return updated;
}

/** SIG-S5 Policy 35 — pre-arrival cancellation at S5: penalty from snapshot/config (unless GM waives), cap at advance, post to folio, release hold. */
export async function cancelEntryAtS5(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  opts?: { penaltyWaiverRequested?: boolean; actorLevel?: RequestActorLevel },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { folio: true, reservation: true, committedHold: true, inquiry: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.status === EntryStatus.CANCELLED) {
    throw new ValidationError("Entry is already cancelled");
  }
  if (entry.status !== EntryStatus.ACTIVE) {
    throw new StateTransitionError("Cancellation is only supported for ACTIVE entries");
  }

  enforceEntryAtS5ForS5CancellationRoute({ currentStage: entry.currentStage });
  enforceReservationPresentForS5CancellationPolicy35({ reservation: entry.reservation });
  enforceFolioPresentForS5CancellationPolicy35({ folio: entry.folio });

  const folio = entry.folio!;
  const reservation = entry.reservation!;
  const now = new Date();

  const waiver = opts?.penaltyWaiverRequested === true;
  if (waiver && !opts?.actorLevel) {
    throw new ValidationError("actorLevel is required when penaltyWaiverRequested is true");
  }
  if (opts?.actorLevel) {
    enforceGmAuthorityForCancellationPenaltyWaiver({
      penaltyWaiverRequested: waiver,
      actorLevel: opts.actorLevel,
    });
  }

  const traceActorLevel = (opts?.actorLevel ?? "L2") as ActorLevel;

  const advanceTotal = await sumAdvancePaymentInTotalForFolio(prisma, folio.id);

  const policyTiers = await requireActiveConfigValue<CancellationPolicyTiersConfig>(prisma, "cancellation.policyTiers").catch(
    () => null as CancellationPolicyTiersConfig | null,
  );

  const { rawPenalty, hoursUntilCheckIn } = computeS5PreArrivalCancellationPenalty({
    now,
    checkInDate: reservation.frozenCheckInDate,
    frozenCancellationTerms: (reservation.frozenCancellationTerms as Record<string, unknown>) ?? {},
    policyTiers,
  });
  const cappedPenalty = capCancellationPenaltyAtAdvancePayment(rawPenalty, advanceTotal);
  const penalty = waiver ? 0 : cappedPenalty;
  const netRefund = advanceTotal - penalty;

  const timers = await prisma.timerRecord.findMany({
    where: { entryId, status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
    take: 50,
  });

  const updated = await prisma.$transaction(async (tx) => {
    if (penalty > 0) {
      await tx.folioLine.create({
        data: {
          folioId: folio.id,
          lineType: FolioLineType.SERVICE,
          description: "Pre-arrival cancellation penalty",
          amount: penalty,
          currency: "BTN",
          chargeDate: now,
          stage: Stage.S5,
          postedBy: actorId,
        },
      });
    }

    if (netRefund > 0) {
      const refundId = await allocateReadableId(tx, "PAYMENT" as const, now);
      await tx.paymentRecord.create({
        data: {
          id: refundId,
          folioId: folio.id,
          entryId,
          amount: netRefund,
          paymentDirection: "OUT",
          recordedBy: actorId,
          stage: Stage.S5,
          notes: "Refund obligation after pre-arrival cancellation",
        },
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.S5.CANCELLED",
        actorId,
        actorLevel: traceActorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S5,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          penalty,
          cappedPenalty,
          advanceTotal,
          netRefund,
          rawPenalty,
          hoursUntilCheckIn,
          penaltyWaiverRequested: waiver,
        },
        createdBy: actorId,
      },
    });

    const hold = entry.committedHold;
    if (hold && hold.state !== HoldState.RELEASED && hold.state !== HoldState.EXPIRED) {
      if (hold.roomId) {
        const room = await tx.room.findUnique({ where: { id: hold.roomId } });
        const fromState = room?.currentClaimState;
        if (fromState && fromState !== InventoryClaimState.FREE) {
          await tx.room.update({
            where: { id: hold.roomId },
            data: { currentClaimState: InventoryClaimState.FREE },
          });
          await tx.roomClaimStateEvent.create({
            data: {
              roomId: hold.roomId,
              entryId,
              fromState,
              toState: InventoryClaimState.FREE,
              actorId,
              reason: "S5_PRE_ARRIVAL_CANCELLATION",
              effectiveFrom: now,
            },
          });
        }
      }
      await tx.committedHold.update({
        where: { id: hold.id },
        data: {
          state: HoldState.RELEASED,
          releasedAt: now,
          releasedBy: actorId,
          releaseReason: "S5_PRE_ARRIVAL_CANCELLATION",
        },
      });
    }

    if (timers.length > 0) {
      await tx.timerRecord.updateMany({
        where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "S5 entry cancelled" } as any,
      });
    }

    await recomputeFolioOutstandingBalance(tx, folio.id);

    return tx.entry.update({
      where: { id: entryId },
      data: {
        status: EntryStatus.CANCELLED,
        currentStage: Stage.TERMINAL,
        closedAt: now,
        closedBy: actorId,
        version: { increment: 1 },
      },
    });
  });

  Promise.resolve().then(async () => {
    try {
      const engine = await getTimerEngine();
      await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
    } catch {
      // best-effort
    }
  });

  return updated;
}

/** SIG-S6 Policy 35 — post-check-in early departure (entry at S7, folio LIVE): penalty to folio, room released, entry cancelled. */
export async function cancelEntryEarlyDepartureAfterCheckIn(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  opts?: { penaltyWaiverRequested?: boolean; actorLevel?: RequestActorLevel },
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      folio: true,
      reservation: true,
      inquiry: true,
      roomAssignments: { include: { room: true }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.status === EntryStatus.CANCELLED) {
    throw new ValidationError("Entry is already cancelled");
  }
  if (entry.status !== EntryStatus.ACTIVE) {
    throw new StateTransitionError("Cancellation is only supported for ACTIVE entries");
  }

  enforceEntryAtS7ForPostCheckInEarlyDepartureCancellation({ currentStage: entry.currentStage });
  enforceFolioPresentForS5CancellationPolicy35({ folio: entry.folio });
  const folio = entry.folio!;
  if (folio.state !== FolioState.LIVE) {
    throw new ValidationError("Early departure cancellation requires a LIVE folio");
  }

  const waiver = opts?.penaltyWaiverRequested === true;
  if (waiver && !opts?.actorLevel) {
    throw new ValidationError("actorLevel is required when penaltyWaiverRequested is true");
  }
  if (opts?.actorLevel) {
    enforceGmAuthorityForCancellationPenaltyWaiver({
      penaltyWaiverRequested: waiver,
      actorLevel: opts.actorLevel,
    });
  }

  const traceActorLevel = (opts?.actorLevel ?? "L2") as ActorLevel;
  const now = new Date();

  const advanceTotal = await sumAdvancePaymentInTotalForFolio(prisma, folio.id);
  const policyTiers = await requireActiveConfigValue<CancellationPolicyTiersConfig>(prisma, "cancellation.policyTiers").catch(
    () => null as CancellationPolicyTiersConfig | null,
  );
  const rawPenalty = computePostCheckInEarlyDeparturePenalty({ policyTiers });
  const cappedPenalty = capCancellationPenaltyAtAdvancePayment(rawPenalty, advanceTotal);
  const penalty = waiver ? 0 : cappedPenalty;

  const timers = await prisma.timerRecord.findMany({
    where: { entryId, status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
    take: 50,
  });

  const assignment = entry.roomAssignments[0];
  const room = assignment?.room;

  const updated = await prisma.$transaction(async (tx) => {
    if (penalty > 0) {
      await tx.folioLine.create({
        data: {
          folioId: folio.id,
          lineType: FolioLineType.SERVICE,
          description: "Early departure cancellation penalty (post check-in)",
          amount: penalty,
          currency: "BTN",
          chargeDate: now,
          stage: Stage.S7,
          postedBy: actorId,
        },
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "ENTRY.S7.EARLY_DEPARTURE_CANCELLED",
        actorId,
        actorLevel: traceActorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { penalty, rawPenalty, cappedPenalty, advanceTotal, penaltyWaiverRequested: waiver },
        createdBy: actorId,
      },
    });

    if (room && room.currentClaimState === InventoryClaimState.OCCUPIED) {
      await tx.room.update({
        where: { id: room.id },
        data: { currentClaimState: InventoryClaimState.FREE, updatedAt: now },
      });
      await tx.roomClaimStateEvent.create({
        data: {
          roomId: room.id,
          entryId,
          fromState: InventoryClaimState.OCCUPIED,
          toState: InventoryClaimState.FREE,
          actorId,
          reason: "S7_EARLY_DEPARTURE_CANCELLATION",
          effectiveFrom: now,
        },
      });
    }

    if (timers.length > 0) {
      await tx.timerRecord.updateMany({
        where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "S7 early departure cancellation" } as any,
      });
    }

    await recomputeFolioOutstandingBalance(tx, folio.id);

    return tx.entry.update({
      where: { id: entryId },
      data: {
        status: EntryStatus.CANCELLED,
        currentStage: Stage.TERMINAL,
        closedAt: now,
        closedBy: actorId,
        version: { increment: 1 },
      },
    });
  });

  Promise.resolve().then(async () => {
    try {
      const engine = await getTimerEngine();
      await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
    } catch {
      // best-effort
    }
  });

  return updated;
}
