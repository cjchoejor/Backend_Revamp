import type { PrismaClient } from "@prisma/client";
import { EntryUseType, PaymentDirection, PreArrivalTaskType, Stage, TaskCategory, TaskStatus } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import {
  enforcePreArrivalTaskPendingForUpdate,
  enforcePreArrivalTaskWaiveRequiresReason,
} from "../../policies/03-expiry-parking/p09-s5-normal-exit-pre-arrival-tasks-terminal.js";
import { dispatchPreArrivalOutboundTx } from "./communication-service.js";
import { dispatchStageEmailBestEffort } from "../infrastructure/stage-email-helpers.js";
import { renderPreArrivalEmail } from "../infrastructure/stage-email-templates.js";

function categoryForTaskType(taskType: PreArrivalTaskType): TaskCategory {
  switch (taskType) {
    case PreArrivalTaskType.PRE_ARRIVAL_COMMUNICATION:
      return TaskCategory.COMMUNICATION;
    case PreArrivalTaskType.BED_CONFIGURATION_CHANGE:
    case PreArrivalTaskType.SPECIAL_REQUEST_FULFILMENT:
    case PreArrivalTaskType.LATE_ARRIVAL_MEAL_COORDINATION:
    case PreArrivalTaskType.SITE_VISIT:
    case PreArrivalTaskType.UNIT_READINESS_VERIFICATION:
      return TaskCategory.OPERATIONAL;
    default:
      return TaskCategory.ADMINISTRATIVE;
  }
}

/** UTC calendar nights `[checkIn, checkOut)` for in-stay night-audit countdown registration. */
export function listStayNightIsoDates(checkIn: Date, checkOut: Date): string[] {
  const nights: string[] = [];
  let y = checkIn.getUTCFullYear();
  let m = checkIn.getUTCMonth();
  let d = checkIn.getUTCDate();
  const end = new Date(Date.UTC(checkOut.getUTCFullYear(), checkOut.getUTCMonth(), checkOut.getUTCDate(), 0, 0, 0, 0)).getTime();

  for (;;) {
    const t = Date.UTC(y, m, d, 0, 0, 0, 0);
    if (t >= end) break;
    nights.push(new Date(t).toISOString().slice(0, 10));
    const cur = new Date(Date.UTC(y, m, d));
    cur.setUTCDate(cur.getUTCDate() + 1);
    y = cur.getUTCFullYear();
    m = cur.getUTCMonth();
    d = cur.getUTCDate();
  }
  return nights;
}

function expectedAdvanceAmount(
  thresholds: Record<string, { amount?: number } | undefined>,
  useType: EntryUseType,
): number {
  const byUse = thresholds[String(useType)];
  if (byUse && typeof byUse.amount === "number") return byUse.amount;
  const def = thresholds.DEFAULT ?? thresholds.default;
  if (def && typeof def.amount === "number") return def.amount;
  return 0;
}

export async function initialiseTasks(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { reservation: true } });
  if (!entry) throw new NotFoundError("Entry");

  const existing = await prisma.preArrivalTask.findFirst({ where: { entryId } });
  if (existing) return { created: 0, skipped: true } as const;

  const now = new Date();
  const taskTypes = Object.values(PreArrivalTaskType).filter((tt) => {
    if (tt !== PreArrivalTaskType.CREDIT_CEILING_CHECK) return true;
    return entry.reservation?.creditCeilingIfExtended != null;
  });
  await prisma.preArrivalTask.createMany({
    data: taskTypes.map((tt) => ({
      entryId,
      taskType: tt,
      category: categoryForTaskType(tt),
      status: TaskStatus.PENDING,
      createdAt: now,
      createdBy: actorId,
    })),
  });

  return { created: taskTypes.length, skipped: false } as const;
}

/**
 * SIG-S5 Policy 28 — compare advance received vs configured threshold; auto-complete folio flag or surface discrepancy.
 * FOM may still mark reconciled via `POST /folios/:id/advance-payment/reconcile` when shortfall is accepted.
 */
export async function reconcileAdvancePayments(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      folio: { include: { payments: true } },
      reservation: true,
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (!entry.folio) throw new NotFoundError("Folio");

  const thresholds =
    (await requireActiveConfigValue<Record<string, { amount?: number } | undefined>>(prisma, "advancePayment.thresholds", {
      now: new Date(),
    }).catch(() => ({}))) ?? {};
  const expected = expectedAdvanceAmount(thresholds, entry.useType);
  const totalIn = (entry.folio.payments ?? [])
    .filter((p) => p.paymentDirection === PaymentDirection.IN)
    .reduce((sum, p) => sum + Number(p.amount.toString()), 0);

  if (entry.folio.advancePaymentReconciliationComplete) {
    return { reconciled: true as const, expected, totalIn, alreadyComplete: true as const };
  }

  const now = new Date();
  if (totalIn >= expected) {
    await prisma.$transaction(async (tx) => {
      await tx.folio.update({
        where: { id: entry.folio!.id },
        data: { advancePaymentReconciliationComplete: true },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "ADVANCE_PAYMENT.S5_RECONCILIATION_AUTO",
          actorId,
          actorLevel: "L1",
          entityType: "Folio",
          entityId: entry.folio!.id,
          operation: "UPDATE",
          timestamp: now,
          stageContext: entry.currentStage,
          inquiryId: entry.inquiryId,
          entryId,
          payload: { entryId, folioId: entry.folio!.id, expected, totalIn },
          createdBy: actorId,
        },
      });
    });
    return { reconciled: true as const, expected, totalIn };
  }

  await prisma.traceEvent.create({
    data: {
      eventType: "ADVANCE_PAYMENT.S5_RECONCILIATION_DISCREPANCY",
      actorId,
      actorLevel: "L1",
      entityType: "Folio",
      entityId: entry.folio.id,
      operation: "ALERT",
      timestamp: now,
      stageContext: entry.currentStage,
      inquiryId: entry.inquiryId,
      entryId,
      payload: { entryId, folioId: entry.folio.id, expected, totalIn, shortfall: expected - totalIn },
      createdBy: actorId,
    },
  });

  return { reconciled: false as const, expected, totalIn, shortfall: expected - totalIn };
}

/**
 * SIG-S5 Policy 59 — register pg-boss countdown per expected stay night (informational **W37**).
 */
export async function registerNightAuditTimers(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { reservation: true } });
  if (!entry?.reservation) throw new NotFoundError("Reservation");

  const scheduleCfg = await requireActiveConfigValue<{ stayNightReminderHourUtc?: number }>(prisma, "nightAudit.schedule", {
    now: new Date(),
  }).catch(() => ({ stayNightReminderHourUtc: 14 }));
  const hourUtc = scheduleCfg.stayNightReminderHourUtc ?? 14;

  const ci = entry.reservation.frozenCheckInDate;
  const co = entry.reservation.frozenCheckOutDate;
  const nightDates = listStayNightIsoDates(ci, co);
  if (nightDates.length === 0) {
    return { scheduled: 0, nights: nightDates } as const;
  }

  const engine = await getTimerEngine();
  const now = new Date();
  let scheduled = 0;

  for (const operatingDateIso of nightDates) {
    const dup = await prisma.timerRecord.findFirst({
      where: {
        entryId,
        timerCode: "NIGHT_AUDIT_STAY_NIGHT_W37",
        status: "SCHEDULED",
        payload: { equals: { entryId, operatingDateIso } },
      },
    });
    if (dup) continue;

    const [yy, mm, dd] = operatingDateIso.split("-").map((x) => Number(x));
    const firesAt = new Date(Date.UTC(yy, mm - 1, dd, hourUtc, 0, 0, 0));
    if (firesAt.getTime() <= now.getTime()) continue;

    const jobId = await engine.schedule(
      "NIGHT_AUDIT_STAY_NIGHT_W37",
      { entryId, operatingDateIso },
      { startAfter: firesAt },
    );

    await prisma.timerRecord.create({
      data: {
        entryId,
        entityType: "Entry",
        entityId: entryId,
        timerType: "NIGHT_AUDIT_STAY_NIGHT_W37",
        timerCode: "NIGHT_AUDIT_STAY_NIGHT_W37",
        stageContext: Stage.S5,
        firesAt,
        dueAt: firesAt,
        status: "SCHEDULED",
        payload: { entryId, operatingDateIso },
        pgBossJobId: jobId,
        createdBy: actorId,
      },
    });
    scheduled += 1;
  }

  await prisma.traceEvent.create({
    data: {
      eventType: "NIGHT_AUDIT_TIMERS.S5_REGISTERED",
      actorId,
      actorLevel: actorId === "SYSTEM" ? "SYSTEM" : "L1",
      entityType: "Entry",
      entityId: entryId,
      operation: "CREATE",
      timestamp: now,
      stageContext: entry.currentStage,
      inquiryId: entry.inquiryId,
      entryId,
      payload: { entryId, nights: nightDates, scheduledJobCount: scheduled },
      createdBy: actorId,
    },
  });

  return { scheduled, nights: nightDates } as const;
}

/** SIG-S5 Policy 52 — single governed pre-arrival outbound (used when completing `PRE_ARRIVAL_COMMUNICATION`). */
export async function sendPreArrivalReminderOutbound(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { reservation: true },
  });
  if (!entry?.reservation) throw new NotFoundError("Reservation");
  const reservation = entry.reservation;

  const templatesRaw: Record<string, unknown> =
    (await requireActiveConfigValue<Record<string, unknown>>(prisma, "preArrival.communicationTemplates", {
      now: new Date(),
    }).catch(() => ({}))) ?? {};
  const reminder = templatesRaw["reminder"];
  const templateKey =
    typeof reminder === "string" && reminder.length > 0 ? reminder : "pre-arrival-reminder-v1";

  const ackWindows = await requireActiveConfigValue<Record<string, number>>(prisma, "acknowledgement.windowPerType", {
    now: new Date(),
  });
  const ackSec = Number(ackWindows.preArrival ?? ackWindows.voucher ?? 86_400);
  const ref = `pre-arrival-${entryId}-${Date.now()}`;

  await prisma.$transaction(async (tx) => {
    await dispatchPreArrivalOutboundTx(tx, {
      entryId,
      actorId,
      reservationId: reservation.id,
      otaSource: entry.otaSource,
      ackSeconds: ackSec,
      ref,
      templateKey,
    });
  });

  // Phase 3 — outbound pre-arrival email (best-effort, post-tx).
  const full = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { guestProfile: true, reservation: true },
  });
  if (full) {
    const displayName =
      [full.guestProfile?.firstName, full.guestProfile?.lastName].filter(Boolean).join(" ") || "Guest";
    const ci = full.reservation?.frozenCheckInDate ?? full.checkInDate ?? new Date();
    const co = full.reservation?.frozenCheckOutDate ?? full.checkOutDate ?? new Date(ci.getTime() + 86400_000);
    const content = renderPreArrivalEmail({
      guestDisplayName: displayName,
      reservationReadableId: full.reservation?.id ?? entryId,
      checkInDate: ci,
      checkOutDate: co,
      guestCount: full.reservation?.frozenGuestCount ?? full.guestCount ?? 1,
    });
    await dispatchStageEmailBestEffort(
      {
        prisma,
        entryId,
        actorId,
        inquiryId: full.inquiryId,
        guestEmail: full.guestProfile?.email ?? null,
        stage: Stage.S5,
        eventTypePrefix: "PRE_ARRIVAL_EMAIL",
      },
      content,
    );
  }
}

export async function evaluateCreditCeiling(prisma: PrismaClient, entryId: string, actorId: string) {
  const now = new Date();
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { reservation: true, folio: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (!entry.reservation?.creditCeilingIfExtended) {
    throw new ValidationError("creditCeilingIfExtended not set on reservation; credit ceiling does not apply");
  }
  if (!entry.folio) throw new NotFoundError("Folio");

  const thresholds = await requireActiveConfigValue<{ tier1Percent: number; tier2Percent: number }>(
    prisma,
    "creditCeiling.proximityThresholds",
    { now },
  );
  const ceiling = Number(entry.reservation.creditCeilingIfExtended.toString());
  const out = Number((entry.folio.outstandingBalance ?? 0).toString());
  const pct = ceiling > 0 ? (out / ceiling) * 100 : 0;

  const crossedTier2 = pct >= thresholds.tier2Percent;
  const crossedTier1 = !crossedTier2 && pct >= thresholds.tier1Percent;

  if (!crossedTier1 && !crossedTier2) {
    return { thresholdCrossed: false, tier: null, percentage: pct };
  }

  const thresholdPercent = crossedTier2 ? thresholds.tier2Percent : thresholds.tier1Percent;

  await prisma.$transaction(async (tx) => {
    await tx.creditCeilingThresholdEvent.create({
      data: {
        entryId,
        folioId: entry.folio!.id,
        ceilingAmount: entry.reservation!.creditCeilingIfExtended!,
        outstandingBalance: entry.folio!.outstandingBalance ?? (0 as any),
        thresholdPercent,
        createdBy: actorId,
      },
    });
    await tx.traceEvent.create({
      data: {
        eventType: crossedTier2 ? "CREDIT_CEILING.TIER2_INTERRUPTION" : "CREDIT_CEILING.TIER1_NOTICE",
        actorId,
        actorLevel: actorId === "SYSTEM" ? "SYSTEM" : "L1",
        entityType: "Entry",
        entityId: entryId,
        operation: "ALERT",
        timestamp: now,
        stageContext: entry.currentStage,
        inquiryId: entry.inquiryId,
        entryId,
        payload: { entryId, ceiling, outstanding: out, percentage: pct, tier: crossedTier2 ? "TIER_2" : "TIER_1" },
        createdBy: actorId,
      },
    });
  });

  return {
    thresholdCrossed: true,
    tier: (crossedTier2 ? "TIER_2" : "TIER_1") as "TIER_1" | "TIER_2",
    percentage: pct,
    requiresFomAcknowledgement: crossedTier2,
  };
}

export async function updatePreArrivalTask(
  prisma: PrismaClient,
  taskId: string,
  actorId: string,
  action: "COMPLETE" | "WAIVE",
  waivedReason?: string,
) {
  const task = await prisma.preArrivalTask.findUnique({ where: { id: taskId } });
  if (!task) throw new NotFoundError("PreArrivalTask");

  enforcePreArrivalTaskPendingForUpdate({ status: task.status });

  if (action === "COMPLETE") {
    if (task.taskType === PreArrivalTaskType.PAYMENT_RECONCILIATION) {
      const r = await reconcileAdvancePayments(prisma, task.entryId, actorId);
      if (!r.reconciled) {
        throw new PolicyGateBlockedError(
          "ADVANCE_PAYMENT_RECONCILIATION",
          `Advance payments below configured threshold (expected ${r.expected}, received ${r.totalIn}). Record additional payment or POST /folios/:id/advance-payment/reconcile after FOM review.`,
        );
      }
    }
    if (task.taskType === PreArrivalTaskType.NIGHT_AUDIT_TIMER_REGISTRATION) {
      await registerNightAuditTimers(prisma, task.entryId, actorId);
    }
    if (task.taskType === PreArrivalTaskType.PRE_ARRIVAL_COMMUNICATION) {
      await sendPreArrivalReminderOutbound(prisma, task.entryId, actorId);
    }
  }

  const entryForTrace = await prisma.entry.findUnique({ where: { id: task.entryId }, select: { inquiryId: true, currentStage: true } });

  if (action === "WAIVE") {
    enforcePreArrivalTaskWaiveRequiresReason({ action, waivedReason });
    return prisma.$transaction(async (tx) => {
      const updated = await tx.preArrivalTask.update({
        where: { id: taskId },
        data: { status: TaskStatus.WAIVED, waivedReason: waivedReason!.trim(), waivedBy: actorId },
      });
      await tx.traceEvent.create({
        data: {
          eventType: "PRE_ARRIVAL_TASK.WAIVED",
          actorId,
          actorLevel: "L1",
          entityType: "PreArrivalTask",
          entityId: taskId,
          operation: "UPDATE",
          timestamp: new Date(),
          stageContext: entryForTrace?.currentStage ?? null,
          inquiryId: entryForTrace?.inquiryId ?? null,
          entryId: task.entryId,
          payload: { entryId: task.entryId, taskType: task.taskType, waivedReason: waivedReason!.trim() },
          createdBy: actorId,
        },
      });
      return updated;
    });
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.preArrivalTask.update({
      where: { id: taskId },
      data: { status: TaskStatus.COMPLETE, completedAt: new Date(), completedBy: actorId },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "PRE_ARRIVAL_TASK.COMPLETED",
        actorId,
        actorLevel: "L1",
        entityType: "PreArrivalTask",
        entityId: taskId,
        operation: "UPDATE",
        timestamp: new Date(),
        stageContext: entryForTrace?.currentStage ?? null,
        inquiryId: entryForTrace?.inquiryId ?? null,
        entryId: task.entryId,
        payload: { entryId: task.entryId, taskType: task.taskType },
        createdBy: actorId,
      },
    });
    return updated;
  });
}

export async function acknowledgeCreditCeilingTier2(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { reservation: true } });
  if (!entry) throw new NotFoundError("Entry");
  if (!entry.reservation?.creditCeilingIfExtended) {
    throw new ValidationError("Credit ceiling does not apply to this entry");
  }
  return prisma.entry.update({
    where: { id: entryId },
    data: {
      creditCeilingTier2AcknowledgedAt: new Date(),
      creditCeilingTier2AcknowledgedBy: actorId,
      version: { increment: 1 },
    },
  });
}
