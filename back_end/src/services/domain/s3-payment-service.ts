import type { Prisma, PrismaClient } from "@prisma/client";
import { PaymentDirection, Stage } from "@prisma/client";
import { MissingConfigurationError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { enforceCreditExtensionConstraints } from "../../policies/18-credit-extension-ceiling/p42-credit-ceiling-mandatory-set.js";
import { enforceAdvancePaymentReconciliationRequiresPayment } from "../../policies/12-advance-payment/p27-advance-payment-reconciliation.js";

function toNumber(v: any): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  return NaN;
}

async function computeAdvancePaymentEvaluation(
  db: PrismaClient | Prisma.TransactionClient,
  input: { entryId: string; folioId: string },
  thresholds: any,
) {
  const folio = await db.folio.findUnique({ where: { id: input.folioId }, include: { payments: true } });
  if (!folio) throw new ValidationError("folioId invalid");
  if (folio.entryId !== input.entryId) throw new ValidationError("entryId/folioId mismatch");

  const requiredAmount = toNumber(thresholds?.DEFAULT?.amount ?? thresholds?.amount ?? 0);
  const totalReceived = (folio.payments ?? [])
    .filter((p) => p.paymentDirection === PaymentDirection.IN)
    .reduce((sum, p) => sum + Number(p.amount.toString()), 0);

  const credit = await db.creditExtensionCeilingRecord.findUnique({ where: { folioId: folio.id } }).catch(() => null);
  const creditExtensionActive = !!credit;

  const satisfied = creditExtensionActive || (Number.isFinite(requiredAmount) ? totalReceived >= requiredAmount : totalReceived > 0);
  const shortfall = Number.isFinite(requiredAmount) ? Math.max(0, requiredAmount - totalReceived) : 0;

  return {
    satisfied,
    totalReceived,
    requiredAmount: Number.isFinite(requiredAmount) ? requiredAmount : 0,
    shortfall,
    creditExtensionActive,
    ceilingAmount: credit ? Number(credit.ceilingAmount.toString()) : null,
  };
}

export async function evaluateAdvancePaymentCondition(
  prisma: PrismaClient,
  input: { entryId: string; folioId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const thresholds = await requireActiveConfigValue<any>(prisma, "advancePayment.thresholds", { now }).catch(() => {
    throw new MissingConfigurationError("advancePayment.thresholds");
  });
  return computeAdvancePaymentEvaluation(prisma, input, thresholds);
}

/** Reads folio/payments on `tx` (including uncommitted rows) while loading thresholds from the root client. */
export async function evaluateAdvancePaymentConditionTx(
  prisma: PrismaClient,
  tx: Prisma.TransactionClient,
  input: { entryId: string; folioId: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const thresholds = await requireActiveConfigValue<any>(prisma, "advancePayment.thresholds", { now }).catch(() => {
    throw new MissingConfigurationError("advancePayment.thresholds");
  });
  return computeAdvancePaymentEvaluation(tx, input, thresholds);
}

/** SIG §6.4 — façade name for API / callers. */
export async function getPaymentStatus(prisma: PrismaClient, input: { entryId: string; folioId: string; now?: Date }) {
  return evaluateAdvancePaymentCondition(prisma, input);
}

export async function cancelScheduledAdvancePaymentFollowUpForEntry(
  tx: Prisma.TransactionClient,
  entryId: string,
  cancelledBy: string,
  reason: string,
) {
  const now = new Date();
  const timers = await tx.timerRecord.findMany({
    where: { entryId, timerType: "ADVANCE_PAYMENT_FOLLOW_UP_W34", status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
  });
  if (timers.length === 0) return { cancelled: 0 } as const;
  const engine = await getTimerEngine();
  await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  await tx.timerRecord.updateMany({
    where: { id: { in: timers.map((t) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy, cancelledReason: reason },
  });
  return { cancelled: timers.length } as const;
}

export async function recordCreditExtensionApproval(
  prisma: PrismaClient,
  input: { entryId: string; folioId: string; ceilingAmount: number; reason: string },
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
) {
  enforceCreditExtensionConstraints({ actorLevel: actor.actorLevel, ceilingAmount: input.ceilingAmount, reason: input.reason });

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const rec = await tx.creditExtensionCeilingRecord.upsert({
      where: { folioId: input.folioId },
      create: {
        folioId: input.folioId,
        entryId: input.entryId,
        ceilingAmount: input.ceilingAmount,
        approvedBy: actor.actorId,
        approvedAt: now,
        reason: input.reason.trim(),
      },
      update: {
        ceilingAmount: input.ceilingAmount,
        approvedBy: actor.actorId,
        approvedAt: now,
        reason: input.reason.trim(),
      },
    });

    await cancelScheduledAdvancePaymentFollowUpForEntry(tx, input.entryId, actor.actorId, "CREDIT_EXTENSION_APPROVED");

    await tx.traceEvent.create({
      data: {
        eventType: "CREDIT_EXTENSION.APPROVED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "CreditExtensionCeilingRecord",
        entityId: rec.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: Stage.S3,
        entryId: input.entryId,
        payload: { entryId: input.entryId, folioId: input.folioId, ceilingAmount: input.ceilingAmount },
        createdBy: actor.actorId,
      },
    });

    return rec;
  });
}

export async function markAdvancePaymentReconciled(
  prisma: PrismaClient,
  input: { entryId: string; folioId: string; note?: string },
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
) {
  const folio = await prisma.folio.findUnique({ where: { id: input.folioId }, include: { payments: true } });
  if (!folio) throw new ValidationError("folioId invalid");
  if (folio.entryId !== input.entryId) throw new ValidationError("entryId/folioId mismatch");

  const totalIn = (folio.payments ?? [])
    .filter((p) => p.paymentDirection === PaymentDirection.IN)
    .reduce((sum, p) => sum + Number(p.amount.toString()), 0);
  const billingModel = String((folio as any).billingModel ?? "").trim();
  const isDirectBillLike = billingModel === "DIRECT_BILL" || billingModel === "GOVERNMENT";
  enforceAdvancePaymentReconciliationRequiresPayment({ isDirectBillLike, totalInPayments: totalIn });

  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const updated = await tx.folio.update({
      where: { id: input.folioId },
      data: { advancePaymentReconciliationComplete: true },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "ADVANCE_PAYMENT.RECONCILED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Folio",
        entityId: input.folioId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S3,
        entryId: input.entryId,
        payload: { entryId: input.entryId, folioId: input.folioId, note: input.note ?? null, totalReceived: totalIn },
        createdBy: actor.actorId,
      },
    });

    await cancelScheduledAdvancePaymentFollowUpForEntry(tx, input.entryId, actor.actorId, "ADVANCE_PAYMENT_RECONCILED");

    return updated;
  });
}

