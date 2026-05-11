import type { PrismaClient } from "@prisma/client";
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

export async function evaluateAdvancePaymentCondition(
  prisma: PrismaClient,
  input: { entryId: string; folioId: string; now?: Date },
) {
  const now = input.now ?? new Date();

  const entry = await prisma.entry.findUnique({ where: { id: input.entryId }, include: { inquiry: true } as any });
  if (!entry) throw new ValidationError("entryId invalid");

  const folio = await prisma.folio.findUnique({ where: { id: input.folioId }, include: { payments: true } });
  if (!folio) throw new ValidationError("folioId invalid");

  const thresholds = await requireActiveConfigValue<any>(prisma, "advancePayment.thresholds", { now }).catch(() => {
    throw new MissingConfigurationError("advancePayment.thresholds");
  });

  // This codebase does not yet model source channel/client tier precisely; treat all as DEFAULT.
  const requiredAmount = toNumber(thresholds?.DEFAULT?.amount ?? thresholds?.amount ?? 0);
  const totalReceived = (folio.payments ?? [])
    .filter((p) => p.paymentDirection === PaymentDirection.IN)
    .reduce((sum, p) => sum + Number(p.amount.toString()), 0);

  const credit = await prisma.creditExtensionCeilingRecord.findUnique({ where: { folioId: folio.id } }).catch(() => null);
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

    // Cancel any advance payment follow-up timers linked to this entry/folio.
    const timers = await tx.timerRecord.findMany({
      where: { entryId: input.entryId, timerType: "ADVANCE_PAYMENT_FOLLOW_UP_W34", status: "SCHEDULED" },
      select: { id: true, pgBossJobId: true },
    });
    const engine = await getTimerEngine();
    await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
    await tx.timerRecord.updateMany({
      where: { id: { in: timers.map((t) => t.id) } },
      data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actor.actorId, cancelledReason: "CREDIT_EXTENSION_APPROVED" },
    });

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

    // Cancel follow-up timer(s) (best-effort), since reconciliation is complete.
    const timers = await tx.timerRecord.findMany({
      where: { entryId: input.entryId, timerType: "ADVANCE_PAYMENT_FOLLOW_UP_W34", status: "SCHEDULED" },
      select: { id: true, pgBossJobId: true },
    });
    const engine = await getTimerEngine();
    await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
    await tx.timerRecord.updateMany({
      where: { id: { in: timers.map((t) => t.id) } },
      data: { status: "CANCELLED", cancelledAt: now, cancelledBy: actor.actorId, cancelledReason: "ADVANCE_PAYMENT_RECONCILED" },
    });

    return updated;
  });
}

