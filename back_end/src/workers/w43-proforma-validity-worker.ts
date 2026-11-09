import type { PrismaClient } from "@prisma/client";
import { InvoiceState, InvoiceType, Stage } from "@prisma/client";
import { evaluateAdvancePaymentCondition } from "../services/domain/s3-payment-service.js";

/**
 * A proforma's time ends (2026-11-05). It is marked, and the desk makes it again: the booking does not
 * lapse, since nothing at Set up lapses a booking. Only at Set up, and not once the advance asked is
 * paid in full: then nothing is left for the guest to answer.
 */
export async function runProformaValidityWorker(prisma: PrismaClient, input: { invoiceId?: string }) {
  const invoiceId = typeof input.invoiceId === "string" ? input.invoiceId : undefined;
  if (!invoiceId) return { skipped: true, reason: "MISSING_INVOICE_ID" } as const;
  const now = new Date();
  const inv = await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { id: true, entryId: true, folioId: true, invoiceType: true, state: true, validUntil: true, lapsedAt: true } });
  if (!inv || inv.invoiceType !== InvoiceType.PROFORMA) return { skipped: true, reason: "NOT_A_PROFORMA" } as const;

  const closeClock = () =>
    prisma.timerRecord.updateMany({
      where: { entityType: "Invoice", entityId: invoiceId, timerType: "PROFORMA_VALIDITY_W43", status: "SCHEDULED" },
      data: { status: "FIRED", firedAt: now },
    });

  if (inv.state === InvoiceState.SUPERSEDED || inv.lapsedAt) {
    await closeClock();
    return { skipped: true, reason: "NOT_LIVE" } as const;
  }
  // Its own time decides: one moved since this job was armed has not ended.
  if (inv.validUntil && inv.validUntil.getTime() > now.getTime() + 5000) return { skipped: true, reason: "NOT_DUE" } as const;

  const entry = await prisma.entry.findUnique({ where: { id: inv.entryId }, select: { currentStage: true, status: true, inquiryId: true } });
  if (entry?.currentStage !== Stage.S3 || (entry.status !== "ACTIVE" && entry.status !== "PARKED")) {
    await closeClock();
    return { skipped: true, reason: "NOT_AT_SET_UP" } as const;
  }
  const money = await evaluateAdvancePaymentCondition(prisma, { entryId: inv.entryId, folioId: inv.folioId });
  if (money.requiredAmount > 0 && money.paidInFull) {
    await closeClock();
    return { skipped: true, reason: "ADVANCE_PAID" } as const;
  }

  await prisma.$transaction(async (tx) => {
    await tx.invoice.update({ where: { id: invoiceId }, data: { lapsedAt: now } });
    await tx.timerRecord.updateMany({
      where: { entityType: "Invoice", entityId: invoiceId, timerType: "PROFORMA_VALIDITY_W43", status: "SCHEDULED" },
      data: { status: "FIRED", firedAt: now },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "PROFORMA.LAPSED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Invoice",
        entityId: invoiceId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S3,
        inquiryId: entry.inquiryId,
        entryId: inv.entryId,
        payload: { invoiceId, entryId: inv.entryId, validUntil: inv.validUntil?.toISOString() ?? null },
        createdBy: "SYSTEM",
      },
    });
  });
  return { skipped: false, invoiceId } as const;
}
