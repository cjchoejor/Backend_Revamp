import type { PrismaClient } from "@prisma/client";
import { Prisma, Stage } from "@prisma/client";
import { armInterimPaymentReminder, loadInterimReminderPolicy } from "../services/domain/interim-payment-service.js";
import { dispatchInterimPaymentReminder } from "../services/infrastructure/notification-service.js";
import { round2, sumMoney, toDecimal } from "../lib/money.js";

/**
 * W41 — mid-stay payment reminder (2026-08-22, operator request).
 *
 * Armed when an interim bill is generated (long-stay ask or stay extension) at the bill's
 * `dueBy`. Fires and answers one question: has the money arrived?
 *
 *  - Paid / withdrawn / lapsed, or the booking moved on → skip quietly.
 *  - Still unpaid → `remindersSent` + 1, trace `INTERIM_PAYMENT.REMINDER_DUE` (what is due, what
 *    came in, whether the bill even went out) and an operator notification, then RE-ARM every
 *    `repeatEveryHours` until `maxReminders` is reached — the hotel is reminded, not just once.
 *
 * Like W38 it gates nothing: the bill's own machinery (Policy 80, W40 for an extension's hold)
 * stays the enforcement; this is the clock that stops the mid-stay payment being forgotten.
 */
export async function runInterimPaymentReminderWorker(
  prisma: PrismaClient,
  input: { interimPaymentRequestId?: string; timerRecordId?: string },
) {
  const now = new Date();
  const requestId = typeof input.interimPaymentRequestId === "string" ? input.interimPaymentRequestId : undefined;
  const markFired = async () => {
    if (typeof input.timerRecordId === "string") {
      await prisma.timerRecord.updateMany({
        where: { id: input.timerRecordId, status: "SCHEDULED" },
        data: { status: "FIRED", firedAt: now },
      });
    }
  };
  if (!requestId) {
    await markFired();
    return { skipped: true, reason: "MISSING_ID" } as const;
  }
  const req = await prisma.interimPaymentRequest.findUnique({
    where: { id: requestId },
    include: {
      entry: { select: { id: true, status: true, currentStage: true, inquiryId: true } },
      invoice: { select: { id: true, state: true, dispatchedAt: true } },
      payments: { select: { amount: true } },
      stayExtensionRequest: { select: { id: true, state: true, holdExpiresAt: true } },
    },
  });
  if (!req) {
    await markFired();
    return { skipped: true, reason: "REQUEST_GONE" } as const;
  }
  if (req.state !== "REQUESTED" && req.state !== "BILLED") {
    await markFired();
    return { skipped: true, reason: `STATE_${req.state}` } as const;
  }
  if (req.entry.status !== "ACTIVE" || req.entry.currentStage !== Stage.S7) {
    await markFired();
    return { skipped: true, reason: "ENTRY_MOVED_ON" } as const;
  }
  if (req.reminderTimerRecordId && typeof input.timerRecordId === "string" && req.reminderTimerRecordId !== input.timerRecordId) {
    // The due-by was moved after this clock was armed — a newer clock owns the reminder.
    await markFired();
    return { skipped: true, reason: "RE_ARMED" } as const;
  }

  const policy = await loadInterimReminderPolicy(prisma);
  const received = sumMoney(req.payments.map((p) => p.amount));
  const due = toDecimal(req.dueNow ?? 0);
  const remainingRaw = due.sub(received);
  const remaining = Number(round2(remainingRaw.lt(0) ? toDecimal(0) : remainingRaw));
  const remindersSent = req.remindersSent + 1;
  const billed = !!req.invoice?.dispatchedAt && req.invoice.state !== "SUPERSEDED";
  const canRepeat = policy.repeatEveryHours > 0 && remindersSent < policy.maxReminders;
  const nextReminderAt = canRepeat ? new Date(now.getTime() + policy.repeatEveryHours * 3_600_000) : null;

  await prisma.interimPaymentRequest.update({
    where: { id: req.id },
    data: { remindersSent, lastReminderAt: now, reminderTimerRecordId: null },
  });
  const payload = {
    entryId: req.entryId,
    interimPaymentRequestId: req.id,
    kind: req.kind,
    invoiceId: req.invoiceId,
    billed,
    dueBy: req.dueBy?.toISOString() ?? null,
    dueNow: Number(round2(due)),
    received: Number(round2(received)),
    remaining,
    remindersSent,
    maxReminders: policy.maxReminders,
    nextReminderAt: nextReminderAt?.toISOString() ?? null,
    stayExtensionRequestId: req.stayExtensionRequestId,
    holdExpiresAt: req.stayExtensionRequest?.holdExpiresAt?.toISOString() ?? null,
    // The guest's promise, when one was recorded — a lapsed promise reads differently from a default due-by.
    promiseKind: req.promiseKind,
    promisedBy: req.promisedBy?.toISOString() ?? null,
  };
  await prisma.traceEvent.create({
    data: {
      eventType: "INTERIM_PAYMENT.REMINDER_DUE",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "InterimPaymentRequest",
      entityId: req.id,
      operation: "ALERT",
      timestamp: now,
      stageContext: Stage.S7,
      inquiryId: req.entry.inquiryId,
      entryId: req.entryId,
      payload: payload as Prisma.InputJsonValue,
      createdBy: "SYSTEM",
    },
  });
  await dispatchInterimPaymentReminder(prisma, {
    entryId: req.entryId,
    interimPaymentRequestId: req.id,
    kind: req.kind,
    billed,
    remaining,
    remindersSent,
    dueBy: req.dueBy,
  }).catch(() => {});
  await markFired();

  if (nextReminderAt) {
    await armInterimPaymentReminder(prisma, { requestId: req.id, actorId: "SYSTEM", firesAt: nextReminderAt }).catch(() => {});
  }
  return { reminded: true, remindersSent, nextReminderAt } as const;
}
