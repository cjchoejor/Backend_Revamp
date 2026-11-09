import { nextProformaNumberTx } from "../../lib/document-numbers.js";
import { afterProformaMadeTx, stopProformaValidityTx } from "./proforma-validity-service.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState, InvoiceState, InvoiceType, PaymentDirection, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceEntryAtS3ForS3DomainOperations } from "../../policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.js";
import {
  enforceAdvancePaymentInboundRecordAtS3,
  enforceEntryWithinAdvanceCollectionWindow,
} from "../../policies/12-advance-payment/p27-advance-payment-inbound-record-at-s3.js";
import {
  enforceProformaDispatchedBeforeAdvancePayment,
  enforceProformaGuestAnswerRecordedBeforeAdvancePayment,
} from "../../policies/12-advance-payment/p27-advance-payment-reconciliation.js";
import { applyInboundPaymentToFolioOutstanding } from "../../lib/folio-outstanding-from-payment.js";
import {
  autoCompletePaymentReconciliationTaskTx,
  cancelScheduledAdvancePaymentFollowUpForEntry,
  cancelScheduledAdvancePromiseDeadlinesForEntry,
  evaluateAdvancePaymentConditionTx,
} from "./s3-payment-service.js";
import {
  confirmHeldRoomsAfterFullPaymentTx,
} from "./s3-hold-service.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { allocateReadableId, READABLE_ID_PREFIXES } from "../../lib/readable-id.js";
import { applyPartyAdvanceRuleTx, ensureProformaOfThisPassTx } from "./s3-payment-service.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { latestDispatchedInForce } from "../../lib/reply-waits.js";

/**
 * SIG-S3 §6.3 — `FolioService.getOrCreate` slice: single provisional folio per entry; trace on create vs continuation.
 */
export async function getOrCreateProvisionalFolio(
  prisma: PrismaClient,
  entryId: string,
  segmentId: string,
  actorId: string,
) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId } });
  if (!entry) throw new NotFoundError("Entry");
  // A lapse leaves the stage where it was, so the gate below passes on a dead booking (2026-10-01).
  enforceEntryNotSealedForWorkingAction({ status: entry.status });
  enforceEntryAtS3ForS3DomainOperations({ currentStage: entry.currentStage });
  const seg = await prisma.segment.findFirst({ where: { id: segmentId, entryId } });
  if (!seg) throw new ValidationError("segmentId does not belong to entry");

  const now = new Date();
  return prisma.$transaction(async (tx) =>
    getOrCreateProvisionalFolioTx(tx, entryId, segmentId, actorId, entry.inquiryId, now),
  );
}

export async function getOrCreateProvisionalFolioTx(
  tx: Prisma.TransactionClient,
  entryId: string,
  segmentId: string,
  actorId: string,
  inquiryId: string | null,
  now: Date,
) {
  const existing = await tx.folio.findUnique({ where: { entryId } });
  if (existing) {
    await tx.traceEvent.create({
      data: {
        eventType: "FOLIO.REENTRY_CONTINUATION",
        actorId,
        actorLevel: "L1",
        entityType: "Folio",
        entityId: existing.id,
        operation: "READ",
        timestamp: now,
        stageContext: Stage.S3,
        inquiryId,
        entryId,
        payload: { folioId: existing.id, entryId, segmentId },
        createdBy: actorId,
      },
    });
    // The folio carries across passes, so only the FIRST pass ever got a starter proforma —
    // a re-entered booking reached Set up with its old bill superseded and nothing in its
    // place (2026-09-25). Every pass has its own now (2026-10-29): an earlier pass's bill is
    // replaced, a missing one is made, this pass's own is left as it is.
    const pass = await tx.segment.findUnique({ where: { id: segmentId }, select: { startedAt: true } });
    // Before the bill, which prints it.
    await applyPartyAdvanceRuleTx(tx, { entryId, folioId: existing.id, segmentId, actorId, now });
    await ensureProformaOfThisPassTx(
      tx,
      { entryId, folioId: existing.id, passStartedAt: pass?.startedAt ?? null, basis: "ARRIVAL_AT_SET_UP", now },
      { actorId, actorLevel: "L1" },
    );
    return existing;
  }

  const folioId = await allocateReadableId(tx, "FOLIO" as const, now);
  const created = await tx.folio.create({
    data: {
      id: folioId,
      entryId,
      state: FolioState.PROVISIONAL,
      billingModel: null,
      createdBy: actorId,
      outstandingBalance: 0,
      advancePaymentReconciliationComplete: false,
    },
  });

  await tx.traceEvent.create({
    data: {
      eventType: "FOLIO.CREATED",
      actorId,
      actorLevel: "L1",
      entityType: "Folio",
      entityId: created.id,
      operation: "CREATE",
      timestamp: now,
      stageContext: Stage.S3,
      inquiryId,
      entryId,
      payload: { folioId: created.id, entryId, segmentId },
      createdBy: actorId,
    },
  });
  await applyPartyAdvanceRuleTx(tx, { entryId, folioId: created.id, segmentId, actorId, now });

  return created;
}

/**
 * SIG §6.3 — `FolioService.recordPayment`: advance IN payment on the provisional folio; cancel
 * W34 when condition satisfied (same tx). Collection window is S3–S6 (2026-08-07, operator
 * request): a guest who paid part of the advance at setup settles the remainder before
 * arrival, at the check-in desk, or — via S8 settlement, not this path — at check-out. The
 * payment row is stamped with the stage it was actually taken at.
 *
 * A payment does not block the rooms (2026-11-09, operator, replacing the 2026-08-10 ruling): the
 * desk is asked to set a block time, and Move to Reserve blocks them if nobody did.
 */
export async function recordPayment(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: { entryId: string; amount: number; notes?: string | null; paymentMethod?: string | null },
  actorLevel?: "L1" | "L2" | "L3" | "L4",
) {
  const txResult = await prisma.$transaction((tx) => recordPaymentTx(prisma, tx, folioId, actorId, input));
  await afterPaymentRecorded(prisma, { entryId: input.entryId, stageAtPayment: txResult.stageAtPayment });
  return txResult.created;
}

/**
 * What the advance being met sets in motion: the follow-ups stop, the promise stands down, the rooms
 * earn Reserved, the proforma stops running. Also run for a stay covered by a trip payment it got no
 * share of (2026-11-09). Each step does nothing when there is nothing to do.
 */
export async function applyAdvanceStandingTx(
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  input: { entryId: string; folioId: string; actorId: string },
) {
  const evalResult = await evaluateAdvancePaymentConditionTx(prisma, tx, { entryId: input.entryId, folioId: input.folioId });
  if (evalResult.satisfied) {
    await cancelScheduledAdvancePaymentFollowUpForEntry(tx, input.entryId, input.actorId, "ADVANCE_PAYMENT_CONDITION_MET");
  }
  // Promise kept — the W38 deadline (and the S5 settlement tick) only stand while money is
  // still owed. `paidInFull` (money alone), not `satisfied`: a credit extension covers the
  // gate but the guest's payment promise stands.
  if (evalResult.paidInFull) {
    await cancelScheduledAdvancePromiseDeadlinesForEntry(tx, input.entryId, input.actorId, "ADVANCE_PAID_IN_FULL");
    await autoCompletePaymentReconciliationTaskTx(
      tx,
      input.entryId,
      { actorId: input.actorId, actorLevel: "L1" },
      "ADVANCE_PAID_IN_FULL",
    );
    // Held → Reserved (2026-08-07): a booking confirmed while the advance was short kept its
    // rooms visibly "Held"; the money just completed, so they earn the Reserved label now.
    // No-op for bookings that weren't payment-pending.
    await confirmHeldRoomsAfterFullPaymentTx(tx, { entryId: input.entryId, actorId: input.actorId });
    // The advance asked is in: nothing is left for the guest to answer, so the proforma stops running.
    if (evalResult.requiredAmount > 0) {
      await stopProformaValidityTx(tx, { entryId: input.entryId, actorId: input.actorId, reason: "ADVANCE_PAID_IN_FULL", now: new Date() });
      // Paid after it ran out: the guest has answered with the money, so it need not be made again.
      await tx.invoice.updateMany({ where: { entryId: input.entryId, invoiceType: "PROFORMA", state: { not: "SUPERSEDED" }, lapsedAt: { not: null } }, data: { lapsedAt: null } });
    }
  }

  return evalResult;
}

/**
 * The payment's own writes and checks, inside the caller's transaction — so the trip's proforma can
 * write several stays' shares of one payment together, all or none (2026-11-07). Every check a
 * stay's own payment has runs here.
 */
export async function recordPaymentTx(
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  folioId: string,
  actorId: string,
  input: { entryId: string; amount: number; notes?: string | null; paymentMethod?: string | null; paidForTrip?: boolean },
) {
  const amountNum = input.amount;
  {
    const folio = await tx.folio.findUnique({ where: { id: folioId }, include: { entry: true, invoices: true } });
    if (!folio?.entry) throw new NotFoundError("Folio");
    if (folio.entryId !== input.entryId) throw new ValidationError("entryId/folioId mismatch");
    const stageAtPayment = folio.entry.currentStage;
    // Money never goes onto a booking that has ended (2026-10-01).
    enforceEntryNotSealedForWorkingAction({ status: folio.entry.status });
    enforceEntryWithinAdvanceCollectionWindow({ currentStage: stageAtPayment });
    enforceAdvancePaymentInboundRecordAtS3({ folioState: folio.state, amount: amountNum });
    // Order of operations at S3 (2026-08-01/03 rulings): the bill goes out first, then the
    // guest's answer is recorded, then the money comes in. Both gates are S3-SCOPED — they
    // govern the pre-confirmation negotiation. From S4 the freeze already bound the terms and
    // the confirmation voucher is the guest's document, so remainder collection at S4–S6 must
    // not dead-end on a proforma that (legitimately, generate-vs-send) never went out.
    if (stageAtPayment === Stage.S3) {
      enforceProformaDispatchedBeforeAdvancePayment({
        proformaInvoices: folio.invoices
          .filter((i) => i.invoiceType === InvoiceType.PROFORMA)
          .map((i) => ({ state: i.state, dispatchedAt: i.dispatchedAt })),
      });
      // Segment-scoped like the p40 freeze gate — CommunicationRecord carries no segmentId,
      // so the current segment's window is the scope.
      const currentSegForComms = await tx.segment.findFirst({
        where: { entryId: input.entryId },
        orderBy: { segmentNumber: "desc" },
        select: { startedAt: true },
      });
      // The proforma in force — a replaced one's answer is never demanded (2026-10-13).
      const latestProformaComm = await latestDispatchedInForce(tx, {
        entryId: input.entryId,
        commType: "PROFORMA_INVOICE",
        since: currentSegForComms?.startedAt ?? null,
      });
      enforceProformaGuestAnswerRecordedBeforeAdvancePayment({ latestDispatchedProformaComm: latestProformaComm });
    }

    const paymentId = await allocateReadableId(tx, "PAYMENT" as const);
    const created = await tx.paymentRecord.create({
      data: {
        id: paymentId,
        folioId,
        entryId: input.entryId,
        amount: amountNum,
        paymentDirection: PaymentDirection.IN,
        currency: "BTN",
        receivedAt: new Date(),
        recordedBy: actorId,
        stage: stageAtPayment,
        notes: input.notes ?? null,
        ...(input.paidForTrip ? { paidForTrip: true } : {}),
        // How it came (2026-09-18) — every advance used to be stored as CASH, the column default.
        ...(input.paymentMethod?.trim() ? { paymentMethod: input.paymentMethod.trim() } : {}),
      },
    });
    await applyInboundPaymentToFolioOutstanding(tx, folioId, amountNum);

    const evalResult = await applyAdvanceStandingTx(prisma, tx, { entryId: input.entryId, folioId, actorId });

    const now = new Date();
    await tx.traceEvent.create({
      data: {
        eventType: "FOLIO.PAYMENT_RECORDED",
        actorId,
        actorLevel: "L1",
        entityType: "PaymentRecord",
        entityId: created.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: stageAtPayment,
        inquiryId: folio.entry.inquiryId,
        entryId: input.entryId,
        payload: { folioId, entryId: input.entryId, amount: amountNum, stage: stageAtPayment, advanceSatisfiedAfter: evalResult.satisfied },
        createdBy: actorId,
      },
    });

    return { created, stageAtPayment };
  }
}

/** What follows a payment once it is written: the rooms blocked at Set up, a moot pay-later ask closed. */
export async function afterPaymentRecorded(prisma: PrismaClient, p: { entryId: string; stageAtPayment: Stage }): Promise<void> {
  // A request to let the guest pay the rest later is moot once nothing is left to pay (2026-10-29).
  if (p.stageAtPayment === Stage.S5 || p.stageAtPayment === Stage.S6) {
    const { closeMootCheckInPaymentRequests } = await import("./checkin-payment-service.js");
    await closeMootCheckInPaymentRequests(prisma, p.entryId, "PAID").catch(() => {});
  }
}

/**
 * SIG §6.3 — create a new **DRAFT** proforma invoice on the folio at S3 (dispatch remains `POST /invoices/:id/dispatch`).
 */
export async function issueInvoice(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: { entryId: string; templateKey?: string },
) {
  return prisma.$transaction(async (tx) => {
    const folio = await tx.folio.findUnique({ where: { id: folioId }, include: { entry: true } });
    if (!folio?.entry) throw new NotFoundError("Folio");
    if (folio.entryId !== input.entryId) throw new ValidationError("entryId/folioId mismatch");
    enforceEntryNotSealedForWorkingAction({ status: folio.entry.status });
    enforceEntryAtS3ForS3DomainOperations({ currentStage: folio.entry.currentStage });
    if (folio.state !== FolioState.PROVISIONAL) {
      throw new ValidationError("issueInvoice at S3 requires a provisional folio");
    }

    const now = new Date();
    // A booking's proformas share one number, each a version of it (2026-11-07).
    const num = await nextProformaNumberTx(tx, input.entryId, folioId, now);
    const inv = await tx.invoice.create({
      data: {
        id: num.id,
        documentNumber: num.documentNumber,
        versionNumber: num.versionNumber,
        folioId,
        entryId: input.entryId,
        invoiceType: InvoiceType.PROFORMA,
        state: InvoiceState.DRAFT,
        templateKey: input.templateKey?.trim() || "proforma-v1",
        issuedAt: now,
        issuedBy: actorId,
        metadata: { basis: "S3 issueInvoice" },
      },
    });
    await afterProformaMadeTx(tx, { invoiceId: inv.id, entryId: input.entryId, actorId, now });

    await tx.traceEvent.create({
      data: {
        eventType: "INVOICE.CREATED",
        actorId,
        actorLevel: "L1",
        entityType: "Invoice",
        entityId: inv.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: Stage.S3,
        inquiryId: folio.entry.inquiryId,
        entryId: input.entryId,
        payload: { folioId, invoiceId: inv.id, invoiceType: "PROFORMA" },
        createdBy: actorId,
      },
    });

    return inv;
  });
}

/** SIG §6.3 / S3→S1 — supersede pending proforma invoices and cancel related timers (same transaction as segment seal). */
export async function supersedePendingInvoicesTx(tx: Prisma.TransactionClient, entryId: string, actorId: string) {
  const now = new Date();
  const invoices = await tx.invoice.findMany({
    where: { entryId, invoiceType: InvoiceType.PROFORMA, state: { in: [InvoiceState.DRAFT, InvoiceState.DISPATCHED] } },
    orderBy: { createdAt: "desc" },
  });
  if (invoices.length === 0) return { superseded: 0 };

  await tx.invoice.updateMany({
    where: { id: { in: invoices.map((i) => i.id) } },
    data: { state: InvoiceState.SUPERSEDED },
  });

  for (const inv of invoices) {
    await tx.traceEvent.create({
      data: {
        eventType: "INVOICE.SUPERSEDED",
        actorId,
        actorLevel: "L2",
        entityType: "Invoice",
        entityId: inv.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S3,
        entryId,
        payload: { entryId, invoiceId: inv.id, reason: "REENTRY_S3_TO_S1" },
        createdBy: actorId,
      },
    });
  }

  const engine = await getTimerEngine();

  const w34 = await tx.timerRecord.findMany({
    where: {
      entryId,
      entityType: "Invoice",
      entityId: { in: invoices.map((i) => i.id) },
      timerType: "ADVANCE_PAYMENT_FOLLOW_UP_W34",
      status: "SCHEDULED",
    },
    select: { id: true, pgBossJobId: true },
  });
  await Promise.all(w34.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  await tx.timerRecord.updateMany({
    where: { id: { in: w34.map((t) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "INVOICE_SUPERSEDED" },
  });

  const w22 = await tx.timerRecord.findMany({
    where: { entryId, timerType: "ACKNOWLEDGEMENT_WINDOW_W22", status: "SCHEDULED", stageContext: Stage.S3 },
    select: { id: true, pgBossJobId: true },
  });
  await Promise.all(w22.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  await tx.timerRecord.updateMany({
    where: { id: { in: w22.map((t) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "REENTRY_S3_TO_S1" },
  });

  const milestones = await tx.timerRecord.findMany({
    where: { entryId, timerType: "PAYMENT_MILESTONE_W21", status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
  });
  await Promise.all(milestones.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  await tx.timerRecord.updateMany({
    where: { id: { in: milestones.map((t) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actorId, cancelledReason: "REENTRY_S3_TO_S1" },
  });

  // The guest's payment promise (W38) described THIS segment's deal — a re-entry supersedes it
  // along with the proforma it answered (the plan itself is segment-scoped by setAt).
  await cancelScheduledAdvancePromiseDeadlinesForEntry(tx, entryId, actorId, "REENTRY_NEW_SEGMENT");

  return { superseded: invoices.length };
}

export async function supersedePendingInvoices(prisma: PrismaClient, entryId: string, actorId: string) {
  return prisma.$transaction(async (tx) => supersedePendingInvoicesTx(tx, entryId, actorId));
}
