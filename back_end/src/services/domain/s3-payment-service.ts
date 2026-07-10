import type { Prisma, PrismaClient } from "@prisma/client";
import { PaymentDirection, Stage } from "@prisma/client";
import { MissingConfigurationError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { enforceCreditExtensionConstraints } from "../../policies/18-credit-extension-ceiling/p42-credit-ceiling-mandatory-set.js";
import { enforceAdvancePaymentReconciliationRequiresPayment } from "../../policies/12-advance-payment/p27-advance-payment-reconciliation.js";
import { recomputeFolioOutstandingBalance } from "../../lib/folio-outstanding-from-payment.js";
import { allocateReadableId } from "../../lib/readable-id.js";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";

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

  // Resolve the base required amount. The config supports two shapes:
  //   1) Flat: { amount: N }
  //   2) Per-source: { DEFAULT: { amount: N }, OTA: { amount: M }, CORPORATE: { amount: P }, ... }
  // When the entry has an ota/source, per-source overrides the DEFAULT; otherwise DEFAULT wins.
  const entry = await db.entry.findUnique({
    where: { id: input.entryId },
    include: { inquiry: { select: { sourceChannel: true } } },
    // groupBillingMode + sourceChannel needed for both boost and per-source resolution.
  });
  const isGroup = entry?.groupBillingMode === "GROUP_MASTER";
  const sourceKey = String(entry?.inquiry?.sourceChannel ?? "").toUpperCase();
  const perSourceAmount = sourceKey && thresholds && typeof thresholds === "object"
    ? toNumber((thresholds as any)[sourceKey]?.amount)
    : NaN;
  const baseRequiredAmount = Number.isFinite(perSourceAmount) && perSourceAmount > 0
    ? perSourceAmount
    : toNumber(thresholds?.DEFAULT?.amount ?? thresholds?.amount ?? 0);

  // Group booking boost — if the parent entry was classified as GROUP_MASTER (Policy 64),
  // multiply the resolved base amount by the policy's `multiplierPercent`. 200 = 2x. This
  // now boosts whichever source shape was resolved above (per-source OTA amount, per-source
  // CORPORATE amount, or DEFAULT) — not only DEFAULT — which was the Loophole 3 bug.
  let requiredAmount = baseRequiredAmount;
  let boostApplied: { multiplierPercent: number; baseAmount: number } | null = null;
  if (isGroup && Number.isFinite(baseRequiredAmount) && baseRequiredAmount > 0) {
    const boostPolicy = await getRegistryPolicy(db as any, "registry.groupBooking.advancePaymentBoost");
    if (boostPolicy && boostPolicy.enabled !== false && typeof boostPolicy.multiplierPercent === "number") {
      const mult = Math.max(0, boostPolicy.multiplierPercent as number) / 100;
      const boosted = baseRequiredAmount * mult;
      if (boosted > baseRequiredAmount) {
        requiredAmount = boosted;
        boostApplied = { multiplierPercent: boostPolicy.multiplierPercent as number, baseAmount: baseRequiredAmount };
      }
    }
  }

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
    // Present only when the group boost actually raised the required amount above the base.
    // The frontend can show a hint on the payment card explaining WHY the amount is higher.
    ...(boostApplied ? { groupBoostApplied: boostApplied } : {}),
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
    // Pre-allocate a readable ID; if upsert hits the update path it's discarded harmlessly.
    const crId = await allocateReadableId(tx, "CREDIT_EXTENSION" as const, now);
    const rec = await tx.creditExtensionCeilingRecord.upsert({
      where: { folioId: input.folioId },
      create: {
        id: crId,
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

    await recomputeFolioOutstandingBalance(tx, input.folioId);

    return updated;
  });
}

