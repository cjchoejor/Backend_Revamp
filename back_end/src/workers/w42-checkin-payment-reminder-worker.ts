import type { PrismaClient } from "@prisma/client";
import { Prisma, Stage } from "@prisma/client";
import { armCheckInPaymentReminder, loadCheckInReminderPolicy, readCheckInPayment } from "../services/domain/checkin-payment-service.js";

/**
 * W42 — the rest of the bill, let to wait at check-in (2026-10-29, operator ruling).
 *
 * Armed when an FOM lets the guest pay the rest of the bill during the stay, at the FOM's due-by.
 * Fires and answers one question: is the rest of the bill still to pay?
 *
 *  - Paid, the decision no longer stands, or the booking moved on (check-out settles it from
 *    here) → close quietly.
 *  - Still to pay → `remindersSent` + 1, trace `CHECKIN_PAYMENT.REMINDER_DUE` and a desk alert
 *    (`NOTIFICATION.CHECKIN_PAYMENT_REMINDER_DISPATCHED`), then re-arm every `repeatEveryHours`
 *    up to `maxReminders` — the mid-stay payment's cadence (`interimPayment.reminder`).
 *
 * It gates nothing: check-out's settlement collects whatever is still owed.
 */
export async function runCheckInPaymentReminderWorker(prisma: PrismaClient, input: { deferralId?: string; timerRecordId?: string }) {
  const now = new Date();
  const markFired = async () => {
    if (typeof input.timerRecordId === "string") {
      await prisma.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } });
    }
  };
  const id = typeof input.deferralId === "string" ? input.deferralId : undefined;
  if (!id) {
    await markFired();
    return { skipped: true, reason: "MISSING_ID" } as const;
  }
  const row = await prisma.checkInPaymentDeferral.findUnique({
    where: { id },
    select: { id: true, entryId: true, status: true, payBy: true, dueBy: true, remindersSent: true, reminderTimerRecordId: true, entry: { select: { status: true, currentStage: true, inquiryId: true } } },
  });
  if (!row) {
    await markFired();
    return { skipped: true, reason: "GONE" } as const;
  }
  if (row.status !== "APPROVED" || row.payBy !== "DURING_STAY") {
    await markFired();
    return { skipped: true, reason: `STATE_${row.status}` } as const;
  }
  if (row.entry.status !== "ACTIVE" || (row.entry.currentStage !== Stage.S6 && row.entry.currentStage !== Stage.S7)) {
    await markFired();
    return { skipped: true, reason: "ENTRY_MOVED_ON" } as const;
  }
  if (row.reminderTimerRecordId && typeof input.timerRecordId === "string" && row.reminderTimerRecordId !== input.timerRecordId) {
    await markFired();
    return { skipped: true, reason: "RE_ARMED" } as const;
  }

  const standing = await readCheckInPayment(prisma, row.entryId);
  if (standing.stillToPay == null || standing.stillToPay <= 0) {
    await prisma.checkInPaymentDeferral.update({ where: { id: row.id }, data: { reminderTimerRecordId: null } });
    await markFired();
    return { skipped: true, reason: "PAID" } as const;
  }

  const policy = await loadCheckInReminderPolicy(prisma);
  const remindersSent = row.remindersSent + 1;
  const canRepeat = policy.repeatEveryHours > 0 && remindersSent < policy.maxReminders;
  const nextReminderAt = canRepeat ? new Date(now.getTime() + policy.repeatEveryHours * 3_600_000) : null;
  await prisma.checkInPaymentDeferral.update({ where: { id: row.id }, data: { remindersSent, lastReminderAt: now, reminderTimerRecordId: null } });

  const payload = {
    entryId: row.entryId,
    deferralId: row.id,
    dueBy: row.dueBy?.toISOString() ?? null,
    stayTotal: standing.stayTotal,
    received: standing.received,
    remaining: standing.stillToPay,
    remindersSent,
    maxReminders: policy.maxReminders,
    nextReminderAt: nextReminderAt?.toISOString() ?? null,
  };
  await prisma.traceEvent.create({
    data: {
      eventType: "CHECKIN_PAYMENT.REMINDER_DUE",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "CheckInPaymentDeferral",
      entityId: row.id,
      operation: "ALERT",
      timestamp: now,
      stageContext: row.entry.currentStage,
      inquiryId: row.entry.inquiryId,
      entryId: row.entryId,
      payload: payload as Prisma.InputJsonValue,
      createdBy: "SYSTEM",
    },
  });
  await prisma.traceEvent.create({
    data: {
      eventType: "NOTIFICATION.CHECKIN_PAYMENT_REMINDER_DISPATCHED",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "CheckInPaymentDeferral",
      entityId: row.id,
      operation: "NOTIFY",
      timestamp: now,
      stageContext: row.entry.currentStage,
      inquiryId: row.entry.inquiryId,
      entryId: row.entryId,
      payload: { ...payload, targets: ["OPERATOR"], dispatchedAt: now.toISOString() } as Prisma.InputJsonValue,
      createdBy: "SYSTEM",
    },
  });
  await markFired();
  if (nextReminderAt) await armCheckInPaymentReminder(prisma, { deferralId: row.id, actorId: "SYSTEM", firesAt: nextReminderAt }).catch(() => {});
  return { reminded: true, remindersSent, nextReminderAt } as const;
}
