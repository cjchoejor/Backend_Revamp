import type { PrismaClient } from "@prisma/client";
import { PreArrivalTaskType, Stage, TaskCategory, TaskStatus } from "@prisma/client";
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
import { toDecimal } from "../../lib/money.js";
import { autoCompletePaymentReconciliationTaskTx, evaluateAdvancePaymentCondition } from "./s3-payment-service.js";
import { completeGuestDetailsTaskTx, guestDetailsCoverageForEntry } from "./guest-identity-proof-service.js";

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

export async function initialiseTasks(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { reservation: true } });
  if (!entry) throw new NotFoundError("Entry");

  const now = new Date();
  const taskTypes = Object.values(PreArrivalTaskType).filter((tt) => {
    if (tt !== PreArrivalTaskType.CREDIT_CEILING_CHECK) return true;
    return entry.reservation?.creditCeilingIfExtended != null;
  });
  // Idempotent via the `@@unique([entryId, taskType])` constraint on PreArrivalTask —
  // `skipDuplicates` lets concurrent S4→S5 transitions race safely; whichever hits second sees
  // 0 new inserts. Replaces the findFirst-then-createMany race that could create two full sets.
  const result = await prisma.preArrivalTask.createMany({
    data: taskTypes.map((tt) => ({
      entryId,
      taskType: tt,
      category: categoryForTaskType(tt),
      status: TaskStatus.PENDING,
      createdAt: now,
      createdBy: actorId,
    })),
    skipDuplicates: true,
  });

  return { created: result.count, skipped: result.count === 0 } as const;
}

/**
 * The Arrival checklist starts fresh when the arrival window opens (2026-08-10, operator
 * ruling): the tasks are seeded at S4 confirmation so the front desk can PREP them early (the
 * S4 "Handoff to front desk" section), but prep is not arrival verification — a task ticked at
 * S4 must not land on S5 already green, or the Arrival step reads as done before the arrival
 * operator has looked at anything. So at S4→S5 activation every COMPLETE task resets to
 * PENDING (the default state); who completed what at S4 is preserved on the trace, not the
 * row. WAIVED tasks are NOT reset — a waive says "this doesn't apply to this booking", a
 * decision that carries, and its reason is already recorded.
 *
 * One exception, re-applied immediately: PAYMENT_RECONCILIATION auto-completes again when the
 * advance is already paid in full — the 2026-08-07 rule (the money tick never sits PENDING
 * once the money story is closed) still holds, and the folio's reconciliation flag does not
 * reset, so leaving the task open would contradict the green "Advance reconciled" line
 * standing right next to it.
 */
export async function resetTasksForArrivalVerification(prisma: PrismaClient, entryId: string, actorId: string) {
  const completed = await prisma.preArrivalTask.findMany({
    where: { entryId, status: TaskStatus.COMPLETE },
    select: { id: true, taskType: true, completedAt: true, completedBy: true },
  });
  if (completed.length === 0) return { reset: 0 } as const;

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: { inquiryId: true, folio: { select: { id: true } } },
  });
  const paidInFull = entry?.folio
    ? (await evaluateAdvancePaymentCondition(prisma, { entryId, folioId: entry.folio.id })).paidInFull === true
    : false;
  // Same immediate re-apply as the money tick (2026-08-12): guest details are durable facts —
  // documents captured at S4/prior segments don't un-capture at activation, so a covered party
  // (or a VIP-exempt booking) re-closes GUEST_DETAILS_CAPTURED rather than contradicting the
  // green coverage tag on the guest table right next to it.
  const detailsCoverage = await guestDetailsCoverageForEntry(prisma, entryId).catch(() => null);
  const detailsCovered = detailsCoverage != null && (detailsCoverage.satisfied || detailsCoverage.vipExempt);

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.preArrivalTask.updateMany({
      where: { id: { in: completed.map((t) => t.id) } },
      data: { status: TaskStatus.PENDING, completedAt: null, completedBy: null },
    });
    await tx.traceEvent.create({
      data: {
        eventType: "PRE_ARRIVAL_TASK.RESET_FOR_ARRIVAL_VERIFICATION",
        actorId,
        actorLevel: "SYSTEM",
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S5,
        inquiryId: entry?.inquiryId ?? null,
        entryId,
        payload: {
          reason: "S4 prep does not pre-tick the Arrival checklist",
          reset: completed.map((t) => ({
            taskType: t.taskType,
            completedAt: t.completedAt?.toISOString() ?? null,
            completedBy: t.completedBy,
          })),
        },
        createdBy: actorId,
      },
    });
    if (paidInFull) {
      await autoCompletePaymentReconciliationTaskTx(tx, entryId, { actorId, actorLevel: "L1" }, "ADVANCE_PAID_IN_FULL");
    }
    if (detailsCovered) {
      await completeGuestDetailsTaskTx(
        tx,
        entryId,
        { actorId, actorLevel: "L1" },
        detailsCoverage!.satisfied ? "COVERAGE_SATISFIED" : "VIP_EXEMPT",
      );
    }
  });

  return { reset: completed.length, paymentTaskReclosed: paidInFull, guestDetailsTaskReclosed: detailsCovered } as const;
}

/**
 * SIG-S5 Policy 28 — compare advance received vs the REQUIRED amount; auto-complete folio flag
 * or surface discrepancy. FOM may still mark reconciled via
 * `POST /folios/:id/advance-payment/reconcile` when shortfall is accepted.
 *
 * Since 2026-08-07 the comparison runs through `evaluateAdvancePaymentCondition` — the same
 * evaluation the S5/S6 gates and the desk use — instead of re-deriving a threshold from raw
 * config. The old derivation ignored the operator-pinned per-booking requirement, the group
 * boost, per-source thresholds AND credit-extension expiry, so this tick could disagree with
 * every other advance surface (e.g. auto-completing against the config default when the desk
 * had pinned a higher figure, or honouring an extension whose clock had run out).
 */
export async function reconcileAdvancePayments(prisma: PrismaClient, entryId: string, actorId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      folio: true,
      reservation: true,
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (!entry.folio) throw new NotFoundError("Folio");

  const evaluation = await evaluateAdvancePaymentCondition(prisma, { entryId, folioId: entry.folio.id });
  const expected = evaluation.requiredAmount;
  const totalIn = evaluation.totalReceived;

  if (entry.folio.advancePaymentReconciliationComplete) {
    return { reconciled: true as const, expected, totalIn, alreadyComplete: true as const };
  }

  // A credit extension (SIG-S3 Policy 42) satisfies the advance condition — the guest
  // legitimately owes nothing up front (deferred / agent-settled). The evaluation already
  // enforces the extension's expiry at read time.
  const creditExtensionActive = evaluation.creditExtensionActive;

  const now = new Date();
  if (evaluation.satisfied) {
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
          payload: { entryId, folioId: entry.folio!.id, expected, totalIn, creditExtensionActive },
          createdBy: actorId,
        },
      });
    });
    return { reconciled: true as const, expected, totalIn, creditExtensionActive };
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
      payload: { entryId, folioId: entry.folio.id, expected, totalIn, shortfall: evaluation.shortfall },
      createdBy: actorId,
    },
  });

  return { reconciled: false as const, expected, totalIn, shortfall: evaluation.shortfall };
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
    // Concurrency: acquire a Postgres advisory transaction lock keyed by (entryId,
    // operatingDateIso) so two concurrent callers (state machine + worker retry) can't both
    // read "no dup" and both create pg-boss jobs + TimerRecord rows. The lock is released on
    // transaction commit/rollback. We re-check dup INSIDE the lock so the classic
    // findFirst-then-create race is impossible.
    const alreadyScheduled = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        `night-audit:${entryId}:${operatingDateIso}`,
      );
      const dup = await tx.timerRecord.findFirst({
        where: {
          entryId,
          timerCode: "NIGHT_AUDIT_STAY_NIGHT_W37",
          status: "SCHEDULED",
          payload: { equals: { entryId, operatingDateIso } },
        },
      });
      if (dup) return true;

      const [yy, mm, dd] = operatingDateIso.split("-").map((x) => Number(x));
      const firesAt = new Date(Date.UTC(yy, mm - 1, dd, hourUtc, 0, 0, 0));
      if (firesAt.getTime() <= now.getTime()) return true;

      // Schedule pg-boss OUTSIDE the tx boundary would risk a rollback leaving an orphan job.
      // pg-boss's own DB writes are not in this Prisma tx, so if the tx rolls back after
      // schedule, the pg-boss job survives. Trade-off: we schedule pg-boss then create the
      // tracker; on tracker-create failure the pg-boss job fires an untracked timer which
      // is caught by the worker's own "no matching TimerRecord" guard.
      const jobId = await engine.schedule(
        "NIGHT_AUDIT_STAY_NIGHT_W37",
        { entryId, operatingDateIso },
        { startAfter: firesAt },
      );
      await tx.timerRecord.create({
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
      return false;
    });
    if (!alreadyScheduled) scheduled += 1;
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
  // Decimal-safe % — outstanding drift near a threshold boundary can mis-trigger reminders.
  const ceilingDec = toDecimal(entry.reservation.creditCeilingIfExtended);
  const outDec = toDecimal(entry.folio.outstandingBalance ?? 0);
  const pct = ceilingDec.gt(0) ? Number(outDec.div(ceilingDec).mul(100).toFixed(4)) : 0;

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
        payload: { entryId, ceiling: Number(ceilingDec.toFixed(2)), outstanding: Number(outDec.toFixed(2)), percentage: pct, tier: crossedTier2 ? "TIER_2" : "TIER_1" },
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
