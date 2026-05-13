import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState, InvoiceState, InvoiceType, PaymentDirection, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { enforceEntryAtS3ForS3DomainOperations } from "../../policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.js";
import { enforceAdvancePaymentInboundRecordAtS3 } from "../../policies/12-advance-payment/p27-advance-payment-inbound-record-at-s3.js";
import { applyInboundPaymentToFolioOutstanding } from "../../lib/folio-outstanding-from-payment.js";
import {
  cancelScheduledAdvancePaymentFollowUpForEntry,
  evaluateAdvancePaymentConditionTx,
} from "./s3-payment-service.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";

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
    return existing;
  }

  const created = await tx.folio.create({
    data: {
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

  return created;
}

/**
 * SIG §6.3 — `FolioService.recordPayment`: advance IN payment on provisional folio at S3; cancel W34 when condition satisfied (same tx).
 */
export async function recordPayment(
  prisma: PrismaClient,
  folioId: string,
  actorId: string,
  input: { entryId: string; amount: number; notes?: string | null },
) {
  const amountNum = input.amount;
  return prisma.$transaction(async (tx) => {
    const folio = await tx.folio.findUnique({ where: { id: folioId }, include: { entry: true } });
    if (!folio?.entry) throw new NotFoundError("Folio");
    if (folio.entryId !== input.entryId) throw new ValidationError("entryId/folioId mismatch");
    enforceEntryAtS3ForS3DomainOperations({ currentStage: folio.entry.currentStage });
    enforceAdvancePaymentInboundRecordAtS3({ folioState: folio.state, amount: amountNum });

    const created = await tx.paymentRecord.create({
      data: {
        folioId,
        entryId: input.entryId,
        amount: amountNum,
        paymentDirection: PaymentDirection.IN,
        currency: "BTN",
        receivedAt: new Date(),
        recordedBy: actorId,
        stage: Stage.S3,
        notes: input.notes ?? null,
      },
    });
    await applyInboundPaymentToFolioOutstanding(tx, folioId, amountNum);

    const evalResult = await evaluateAdvancePaymentConditionTx(prisma, tx, { entryId: input.entryId, folioId });
    if (evalResult.satisfied) {
      await cancelScheduledAdvancePaymentFollowUpForEntry(tx, input.entryId, actorId, "ADVANCE_PAYMENT_CONDITION_MET");
    }

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
        stageContext: Stage.S3,
        inquiryId: folio.entry.inquiryId,
        entryId: input.entryId,
        payload: { folioId, entryId: input.entryId, amount: amountNum, advanceSatisfiedAfter: evalResult.satisfied },
        createdBy: actorId,
      },
    });

    return created;
  });
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
    enforceEntryAtS3ForS3DomainOperations({ currentStage: folio.entry.currentStage });
    if (folio.state !== FolioState.PROVISIONAL) {
      throw new ValidationError("issueInvoice at S3 requires a provisional folio");
    }

    const now = new Date();
    const inv = await tx.invoice.create({
      data: {
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

  return { superseded: invoices.length };
}

export async function supersedePendingInvoices(prisma: PrismaClient, entryId: string, actorId: string) {
  return prisma.$transaction(async (tx) => supersedePendingInvoicesTx(tx, entryId, actorId));
}
