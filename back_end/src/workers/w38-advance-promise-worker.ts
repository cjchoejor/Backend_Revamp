import type { PrismaClient } from "@prisma/client";
import {
  evaluateAdvancePaymentCondition,
  resolveAdvancePaymentPlan,
} from "../services/domain/s3-payment-service.js";

/**
 * W38 — advance-payment promise deadline (2026-08-07).
 *
 * Armed by `setAdvancePaymentPlan` when the guest promised the remainder BEFORE check-in by a
 * given date. Fires at that date and answers one question: did the money arrive?
 *
 *  - Paid in full (or the plan/segment moved on) → skip quietly.
 *  - Still short → trace `ADVANCE_PAYMENT.PROMISE_LAPSED` with the shortfall, so the desk's
 *    trace feed and the payment-status `promiseOverdue` fact tell the operator to chase.
 *
 * Deliberately does NOT cancel anything or gate anything — the S5/S6 arrival gates are the
 * enforcement teeth; this is the reminder that the guest's word ran out.
 */
export async function runAdvancePromiseDeadlineWorker(
  prisma: PrismaClient,
  input: { entryId?: string; folioId?: string; timerRecordId?: string },
) {
  const now = new Date();
  const entryId = typeof input.entryId === "string" ? input.entryId : undefined;
  const folioId = typeof input.folioId === "string" ? input.folioId : undefined;
  if (!entryId || !folioId) return { skipped: true, reason: "MISSING_IDS" } as const;

  const markFired = async () => {
    if (typeof input.timerRecordId === "string") {
      await prisma.timerRecord.updateMany({
        where: { id: input.timerRecordId, status: "SCHEDULED" },
        data: { status: "FIRED", firedAt: now },
      });
    }
  };

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      folio: true,
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { startedAt: true } },
    },
  });
  if (!entry?.folio || entry.folio.id !== folioId) {
    await markFired();
    return { skipped: true, reason: "MISSING_ENTRY_OR_FOLIO" } as const;
  }
  if (entry.status !== "ACTIVE") {
    await markFired();
    return { skipped: true, reason: "ENTRY_NOT_ACTIVE" } as const;
  }

  // The plan is segment-scoped — a fire whose plan was superseded by a re-entry (or cleared)
  // says nothing about the current deal. The backflow cancel is the primary guard; this is
  // defence in depth for the segment-openers that don't route through runBackflow.
  const plan = resolveAdvancePaymentPlan(entry.folio, entry.segments[0]?.startedAt ?? null);
  if (!plan || plan.balanceDueAt !== "BEFORE_CHECKIN") {
    await markFired();
    return { skipped: true, reason: "PLAN_GONE_OR_CHANGED" } as const;
  }

  // Do NOT swallow evaluation errors — a transient failure must let pg-boss retry rather than
  // silently treating the promise as kept (same rule as W34).
  const evaluation = await evaluateAdvancePaymentCondition(prisma, { entryId, folioId });
  if (evaluation.paidInFull) {
    await markFired();
    return { skipped: true, reason: "PROMISE_KEPT" } as const;
  }

  await prisma.traceEvent.create({
    data: {
      eventType: "ADVANCE_PAYMENT.PROMISE_LAPSED",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "Folio",
      entityId: folioId,
      operation: "ALERT",
      timestamp: now,
      stageContext: entry.currentStage,
      entryId,
      payload: {
        entryId,
        folioId,
        promisedBy: plan.promisedBy,
        plan: plan.plan,
        shortfall: evaluation.shortfall,
        totalReceived: evaluation.totalReceived,
        requiredAmount: evaluation.requiredAmount,
        creditExtensionActive: evaluation.creditExtensionActive,
      },
      createdBy: "SYSTEM",
    },
  });

  await markFired();
  return { skipped: false, entryId, shortfall: evaluation.shortfall } as const;
}
