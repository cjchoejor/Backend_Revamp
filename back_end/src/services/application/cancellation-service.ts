import type { PrismaClient } from "@prisma/client";
import { releaseRoomClaimIfOwnedTx } from "../../lib/room-claim-state.js";
import { ActorLevel, EntryStatus, FolioLineType, FolioState, HoldState, InventoryClaimState, Stage } from "@prisma/client";
import { NotFoundError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { enforceEntryAtS3ForS3CancellationRoute, enforceEntryAtS5ForS5CancellationRoute,
  enforceEntryConfirmedForPreArrivalCancellation, enforceEntryAtS7ForPostCheckInEarlyDepartureCancellation } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
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
import { generateCancellationConfirmationPdf } from "../domain/cancellation-confirmation-pdf-service.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import type { ActorLevel as RequestActorLevel } from "../../types/actor.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { allocateReadableId, allocateFolioLineId } from "../../lib/readable-id.js";
import { transitionRoomClaimState } from "../../lib/room-claim-state.js";
import { resolveBillingModelForNewLine } from "../../lib/billing-model-defaults.js";
import { toDecimal } from "../../lib/money.js";

export type CancellationFigures = {
  /** The step the booking is cancelled at — Set up (S3) or Arrival (S5). */
  stage: "S3" | "S5";
  /** Money received against the booking (the advance). */
  advanceReceived: number;
  /** The charge the disclosed terms put on this cancellation, capped at what was received. */
  charge: number;
  /** What goes back to the guest: received − charge. */
  refund: number;
  /** The terms' charge before the cap, for the desk to say when the cap applied. */
  chargeBeforeCap: number;
  /** The charge after the cap, before any waiver. */
  chargeCapped: number;
  hoursUntilCheckIn: number;
  waived: boolean;
};

/**
 * The money a cancellation would move, computed and nothing written (2026-09-18) — shared by the
 * Set-up and Arrival cancellations and the preview the desk shows before the irreversible click
 * (the dialog promised "the disclosed charge, if any, is posted and the rest refunded" without a
 * figure). One computation, so the preview can never disagree with the act.
 *   - Set up (S3): the terms DISCLOSED to the guest; no reservation is frozen yet.
 *   - Arrival (S5): the terms FROZEN on the reservation; the configured tiers fill any gap.
 */
async function cancellationFigures(
  prisma: PrismaClient,
  input: {
    stage: "S3" | "S5";
    folioId: string;
    checkInDate: Date;
    terms: Record<string, unknown>;
    waiver: boolean;
    now: Date;
  },
): Promise<CancellationFigures> {
  const advanceReceived = await sumAdvancePaymentInTotalForFolio(prisma, input.folioId);
  // Arrival bubbles a config-store failure (never a silent zero charge); Set up falls back to the
  // disclosed terms alone, as it always has.
  const policyTiers =
    input.stage === "S5"
      ? await requireActiveConfigValue<CancellationPolicyTiersConfig>(prisma, "cancellation.policyTiers")
      : await requireActiveConfigValue<CancellationPolicyTiersConfig>(prisma, "cancellation.policyTiers").catch(
          () => null as CancellationPolicyTiersConfig | null,
        );
  const { rawPenalty, hoursUntilCheckIn } = computeS5PreArrivalCancellationPenalty({
    now: input.now,
    checkInDate: input.checkInDate,
    frozenCancellationTerms: input.terms,
    policyTiers,
  });
  const capped = capCancellationPenaltyAtAdvancePayment(rawPenalty, advanceReceived);
  const charge = input.waiver ? 0 : capped;
  // Decimal-safe: the refund is the received total less the charge, to the cent.
  const refund = Number(toDecimal(advanceReceived).sub(toDecimal(charge)).toFixed(2));
  return {
    stage: input.stage,
    advanceReceived,
    charge,
    refund,
    chargeBeforeCap: rawPenalty,
    chargeCapped: capped,
    hoursUntilCheckIn,
    waived: input.waiver,
  };
}

/**
 * What cancelling this booking now would charge and refund — nothing written (2026-09-18).
 * Valid at Set up (S3) and Arrival (S5), the two steps a booking is cancelled at.
 */
export async function previewCancellation(prisma: PrismaClient, entryId: string, opts?: { penaltyWaiverRequested?: boolean }) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { folio: true, reservation: true, cancellationDisclosure: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S3 && entry.currentStage !== Stage.S4 && entry.currentStage !== Stage.S5) {
    throw new ValidationError("A booking is cancelled at Set up, Reserve or Arrival — this one is at none of them");
  }
  if (!entry.folio) throw new ValidationError("No folio on the booking — nothing to charge or refund");
  const now = new Date();
  if (entry.currentStage === Stage.S3) {
    return cancellationFigures(prisma, {
      stage: "S3",
      folioId: entry.folio.id,
      checkInDate: entry.checkInDate ?? new Date(now.getTime() + 86400_000),
      terms: (entry.cancellationDisclosure?.disclosedTerms as Record<string, unknown>) ?? {},
      waiver: opts?.penaltyWaiverRequested === true,
      now,
    });
  }
  if (!entry.reservation) throw new ValidationError("No reservation on the booking");
  return cancellationFigures(prisma, {
    stage: "S5",
    folioId: entry.folio.id,
    checkInDate: entry.reservation.frozenCheckInDate,
    terms: (entry.reservation.frozenCancellationTerms as Record<string, unknown>) ?? {},
    waiver: opts?.penaltyWaiverRequested === true,
    now,
  });
}

/**
 * SIG-S3 §6.5 — pre-confirmation cancellation at S3: release the committed hold, cancel timers,
 * supersede any in-flight proforma invoices, compute a penalty per the *disclosed* terms (no
 * frozen reservation exists yet at S3), refund the net advance, and transition entry to terminal.
 *
 * Authority: L1 (FRONT_DESK) minimum per SIG-S3 line 129. GM authority required only when the
 * caller asks to waive the penalty.
 */
/**
 * Emit the A5 Cancellation Confirmation after a cancellation commits.
 *
 * Best-effort by design, matching how stage emails and the S4 voucher are dispatched: the
 * cancellation is already committed and irreversible by this point, so a Puppeteer or disk failure
 * must not surface as a failed cancellation. The document can always be produced later on demand
 * via `GET /api/entries/:id/cancellation-confirmation-pdf`, which reads the same trace payload.
 */
async function emitCancellationConfirmationBestEffort(
  prisma: PrismaClient,
  entryId: string,
  figures: { advanceHeld: number; retained: number; refundIssued: number; penaltyWaived: boolean },
): Promise<void> {
  try {
    await generateCancellationConfirmationPdf(prisma, entryId, {
      advanceHeld: figures.advanceHeld,
      retained: figures.retained,
      refundIssued: figures.refundIssued,
      penaltyWaived: figures.penaltyWaived,
    });
  } catch (e) {
    console.error(`[cancellation] confirmation PDF failed for ${entryId}:`, e);
  }
}

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

  // S3 source of truth for cancellation terms: the disclosure record signed before the hold was
  // placed (per §6.5 — disclosure is a precondition for hold placement). Falls back to the
  // configured policy tiers when no disclosure terms are available (defensive). Computed by the
  // same helper the desk's preview reads, so the two never disagree.
  const disclosedTerms =
    (entry.cancellationDisclosure?.disclosedTerms as Record<string, unknown>) ?? {};
  const fig = await cancellationFigures(prisma, {
    stage: "S3",
    folioId: folio.id,
    checkInDate,
    terms: disclosedTerms,
    waiver,
    now,
  });
  const advanceTotal = fig.advanceReceived;
  const rawPenalty = fig.chargeBeforeCap;
  const cappedPenalty = fig.chargeCapped;
  const hoursUntilCheckIn = fig.hoursUntilCheckIn;
  const penalty = fig.charge;
  const netRefund = fig.refund;

  const timers = await prisma.timerRecord.findMany({
    where: { entryId, status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
    take: 50,
  });

  const updated = await prisma.$transaction(async (tx) => {
    // 1. Penalty line (only if non-zero).
    if (penalty > 0) {
      const penaltyBillingModel = await resolveBillingModelForNewLine(tx, folio.id, FolioLineType.SERVICE);
      await tx.folioLine.create({
        data: {
          id: await allocateFolioLineId(tx, folio.id),
          folioId: folio.id,
          lineType: FolioLineType.SERVICE,
          // Read on the guest's cancellation papers — no stage code (2026-09-18).
          description: "Cancellation charge — cancelled before the booking was confirmed",
          amount: penalty,
          currency: "BTN",
          chargeDate: now,
          stage: Stage.S3,
          postedBy: actorId,
          billingModel: penaltyBillingModel,
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

    // 4. Release the committed hold, return inventory to FREE. Multi-room support: read the
    // hold's perNightBreakdown (populated by s3-hold-service from the sealed AvailabilityConfiguration)
    // so every room the booking held is released, not just hold.roomId. Falls back to
    // hold.roomId for pre-Phase-D holds that don't carry the breakdown.
    const hold = entry.committedHold;
    if (hold && hold.state !== HoldState.RELEASED && hold.state !== HoldState.EXPIRED) {
      const heldRoomIds = new Set<string>();
      if (hold.roomId) heldRoomIds.add(hold.roomId);
      const breakdown = (hold.perNightBreakdown ?? null) as
        | Array<{ date?: string; roomIds?: Array<{ roomId?: string }> }>
        | null;
      if (Array.isArray(breakdown)) {
        for (const n of breakdown) {
          for (const r of n.roomIds ?? []) {
            if (typeof r?.roomId === "string") heldRoomIds.add(r.roomId);
          }
        }
      }
      for (const roomId of heldRoomIds) {
        // Only the flags this booking owns (2026-09-18): cancelling an October booking set a room
        // FREE while another guest slept in it tonight. See releaseRoomClaimIfOwnedTx.
        await releaseRoomClaimIfOwnedTx(tx, { roomId, entryId, actorId, reason: "S3_PRE_CONFIRMATION_CANCELLATION", now });
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

  await emitCancellationConfirmationBestEffort(prisma, entryId, {
    advanceHeld: advanceTotal,
    retained: penalty,
    refundIssued: Math.max(0, netRefund),
    penaltyWaived: waiver && penalty === 0,
  });

  return updated;
}

/** SIG-S5 Policy 35 — pre-arrival cancellation at S5: penalty from snapshot/config (unless GM waives), cap at advance, post to folio, release hold. */
export async function cancelEntryAtS5(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  opts?: { penaltyWaiverRequested?: boolean; actorLevel?: RequestActorLevel; reason?: string },
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

  enforceEntryConfirmedForPreArrivalCancellation({ currentStage: entry.currentStage });
  enforceReservationPresentForS5CancellationPolicy35({ reservation: entry.reservation });
  // Reserve (S4) or Arrival (S5) — the step the booking is cancelled at, for its lines and trace.
  const cancelStage = entry.currentStage === Stage.S4 ? Stage.S4 : Stage.S5;
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

  // S5 pre-arrival penalty: never let a config-store hiccup silently null out the penalty policy.
  // Frozen cancellation terms on the reservation are the primary source; the live policyTiers is a
  // fallback for anything not frozen. Bubble errors so the operator sees them instead of processing
  // a zero-penalty cancellation. The same helper the desk's preview reads.
  const fig = await cancellationFigures(prisma, {
    stage: "S5",
    folioId: folio.id,
    checkInDate: reservation.frozenCheckInDate,
    terms: (reservation.frozenCancellationTerms as Record<string, unknown>) ?? {},
    waiver,
    now,
  });
  const advanceTotal = fig.advanceReceived;
  const rawPenalty = fig.chargeBeforeCap;
  const cappedPenalty = fig.chargeCapped;
  const hoursUntilCheckIn = fig.hoursUntilCheckIn;
  const penalty = fig.charge;
  const netRefund = fig.refund;

  const timers = await prisma.timerRecord.findMany({
    where: { entryId, status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
    take: 50,
  });

  const updated = await prisma.$transaction(async (tx) => {
    if (penalty > 0) {
      const penaltyBillingModel = await resolveBillingModelForNewLine(tx, folio.id, FolioLineType.SERVICE);
      await tx.folioLine.create({
        data: {
          id: await allocateFolioLineId(tx, folio.id),
          folioId: folio.id,
          lineType: FolioLineType.SERVICE,
          description: "Pre-arrival cancellation penalty",
          amount: penalty,
          currency: "BTN",
          chargeDate: now,
          stage: cancelStage,
          postedBy: actorId,
          billingModel: penaltyBillingModel,
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
          stage: cancelStage,
          notes: "Refund obligation after pre-arrival cancellation",
        },
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: `ENTRY.${cancelStage}.CANCELLED`,
        actorId,
        actorLevel: traceActorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: cancelStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          // Why it was cancelled, as the S3 cancellation records it (2026-09-18).
          reason: opts?.reason?.trim() || null,
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
      const heldRoomIds = new Set<string>();
      if (hold.roomId) heldRoomIds.add(hold.roomId);
      const breakdown = (hold.perNightBreakdown ?? null) as
        | Array<{ date?: string; roomIds?: Array<{ roomId?: string }> }>
        | null;
      if (Array.isArray(breakdown)) {
        for (const n of breakdown) {
          for (const r of n.roomIds ?? []) {
            if (typeof r?.roomId === "string") heldRoomIds.add(r.roomId);
          }
        }
      }
      for (const roomId of heldRoomIds) {
        // Only the flags this booking owns (2026-09-18): cancelling an October booking set a room
        // FREE while another guest slept in it tonight. See releaseRoomClaimIfOwnedTx.
        await releaseRoomClaimIfOwnedTx(tx, { roomId, entryId, actorId, reason: `${cancelStage}_PRE_ARRIVAL_CANCELLATION`, now });
      }
      await tx.committedHold.update({
        where: { id: hold.id },
        data: {
          state: HoldState.RELEASED,
          releasedAt: now,
          releasedBy: actorId,
          releaseReason: `${cancelStage}_PRE_ARRIVAL_CANCELLATION`,
        },
      });
    }

    if (timers.length > 0) {
      await tx.timerRecord.updateMany({
        where: { id: { in: timers.map((t) => t.id) }, status: "SCHEDULED" },
        data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: `${cancelStage} entry cancelled` } as any,
      });
    }

    await recomputeFolioOutstandingBalance(tx, folio.id);
    const recomputed = await tx.folio.findUnique({ where: { id: folio.id }, select: { outstandingBalance: true } });

    // Part 13 "folio financial residue governed" (2026-08-22): the folio used to stay LIVE forever
    // behind a CANCELLED booking - nothing could ever settle it. Seal it the way checkout does:
    // OUTSTANDING while money is owed (the S9 follow-up machinery can chase it), SETTLED at zero.
    const residual = Number((recomputed as { outstandingBalance?: unknown } | null)?.outstandingBalance ?? 0);
    await tx.folio.update({
      where: { id: folio.id },
      data: {
        state: Number.isFinite(residual) && residual > 0 ? FolioState.OUTSTANDING : FolioState.SETTLED,
        closedAt: now,
        closedBy: actorId,
      },
    });

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

  await emitCancellationConfirmationBestEffort(prisma, entryId, {
    advanceHeld: advanceTotal,
    retained: penalty,
    refundIssued: Math.max(0, netRefund),
    penaltyWaived: waiver && penalty === 0,
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
      roomAssignments: { include: { room: true }, orderBy: { createdAt: "desc" } },
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
  // S7 post-check-in penalty: bubble config errors — silent null zeroed the penalty and let the
  // guest walk out free.
  const policyTiers = await requireActiveConfigValue<CancellationPolicyTiersConfig>(prisma, "cancellation.policyTiers");
  const rawPenalty = computePostCheckInEarlyDeparturePenalty({ policyTiers });
  const cappedPenalty = capCancellationPenaltyAtAdvancePayment(rawPenalty, advanceTotal);
  const penalty = waiver ? 0 : cappedPenalty;

  const timers = await prisma.timerRecord.findMany({
    where: { entryId, status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
    take: 50,
  });

  // Multi-room bookings need every room's state released back to FREE — not just the first
  // one. Dedup by roomId so a room-change history doesn't double-process the same room.
  const distinctRoomsToRelease = (() => {
    const seen = new Set<string>();
    const list: Array<{ id: string; currentClaimState: InventoryClaimState }> = [];
    for (const a of entry.roomAssignments) {
      if (seen.has(a.roomId)) continue;
      seen.add(a.roomId);
      list.push({ id: a.room.id, currentClaimState: a.room.currentClaimState });
    }
    return list;
  })();

  const updated = await prisma.$transaction(async (tx) => {
    if (penalty > 0) {
      const penaltyBillingModel = await resolveBillingModelForNewLine(tx, folio.id, FolioLineType.SERVICE);
      await tx.folioLine.create({
        data: {
          id: await allocateFolioLineId(tx, folio.id),
          folioId: folio.id,
          lineType: FolioLineType.SERVICE,
          description: "Early departure cancellation penalty (post check-in)",
          amount: penalty,
          currency: "BTN",
          chargeDate: now,
          stage: Stage.S7,
          postedBy: actorId,
          billingModel: penaltyBillingModel,
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

    // Release EVERY assigned room, whatever state it's in — not just OCCUPIED. Prior guard
    // (only-if-OCCUPIED) silently skipped rooms already flipped to DEPARTED_DIRTY by a
    // concurrent S8 attempt or partial retry, leaving the audit trail incomplete and the
    // room stuck. The helper reads the real fromState and is idempotent (returns without
    // doing anything if the room is already FREE), so it's safe on races.
    for (const r of distinctRoomsToRelease) {
      await transitionRoomClaimState(tx, {
        roomId: r.id,
        toState: InventoryClaimState.FREE,
        actorId,
        entryId,
        reason: "S7_EARLY_DEPARTURE_CANCELLATION",
        now,
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
