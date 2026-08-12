import type { PrismaClient } from "@prisma/client";
import { EntryStatus, Stage } from "@prisma/client";
import type { TimerEngine } from "../lib/timer-engine.js";
import { requireActiveConfigValue } from "../lib/config-store.js";
import { getRegistryPolicy } from "../lib/policy-registry-runtime.js";
import * as preArrivalService from "../services/domain/pre-arrival-service.js";
import { enforceReservationSnapshotPresentForS5Activation } from "../policies/01-availability/p01-reservation-snapshot-required-for-s5-activation.js";
import { scheduleS5StageDwellWarningMonitor } from "../lib/schedule-s5-dwell-warning-monitor.js";

export async function runPreArrivalWindowActivationWorker(
  prisma: PrismaClient,
  engine: TimerEngine,
  input: { entryId?: string; timerRecordId?: string },
  opts?: {
    /**
     * Room-change re-walk (2026-08-12): the guest's arrival was already verified this stay —
     * the walk re-passes S4→S5 as paperwork, so the task statuses earned in the prior segment
     * (COMPLETE / WAIVED) carry instead of being reset to PENDING for re-verification.
     * Only the composite room-change service passes this; every other caller (manual route,
     * W4 timer) keeps the 2026-08-10 reset ruling.
     */
    skipTaskReset?: boolean;
  },
) {
  const now = new Date();
  const entryId = typeof input.entryId === "string" ? input.entryId : undefined;
  if (!entryId) return { skipped: true, reason: "MISSING_ENTRY_ID" } as const;

  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { reservation: true } });
  if (!entry) return { skipped: true, reason: "ENTRY_NOT_FOUND" } as const;
  if (entry.currentStage !== Stage.S4) return { skipped: true, reason: "NOT_AT_S4" } as const;
  // Part 3 §3.2.2 — S4→S5 originates from (ACTIVE, S4). A parked entry is a deliberate pause, so
  // the timer must not walk it forward. Skip (not throw): this is the system path, and pg-boss
  // would otherwise retry-and-fail forever. The operator resumes it, and the manual
  // /activate-pre-arrival route re-runs this same worker.
  if (entry.status !== EntryStatus.ACTIVE) {
    return { skipped: true, reason: entry.status === EntryStatus.PARKED ? "ENTRY_PARKED" : "ENTRY_NOT_ACTIVE" } as const;
  }
  enforceReservationSnapshotPresentForS5Activation({ reservation: entry.reservation });

  // Cross-cutting #5: contact person is mandatory before S5. This is the business-rule
  // gate — regardless of whether the booking is direct / OTA / travel agent / corporate, we
  // need a name + phone of the human physically travelling. The travel agent's or corporate
  // account's contact fields describe the agency/company, not the guest — a separate concern.
  // Enforced here (backend, worker path) so all S4→S5 transitions honour it: manual
  // activation via the /activate-pre-arrival endpoint AND the automatic timer-driven path.
  const contactName = entry.contactPersonName?.trim();
  const contactPhone = entry.contactPersonPhone?.trim();
  if (!contactName || !contactPhone) {
    return {
      skipped: true,
      reason: "MISSING_CONTACT_PERSON",
      detail: {
        missingName: !contactName,
        missingPhone: !contactPhone,
        message: "Contact person name and phone are mandatory before S5 activation. Update the entry with the on-site contact's details.",
      },
    } as const;
  }

  // Idempotency is scoped to the CURRENT segment: after a re-entry (e.g. room change) the entry
  // has a prior activation event from its first pass through S4→S5, which must not block
  // re-activation in the new segment.
  const currentSegment = await prisma.segment.findFirst({
    where: { entryId, segmentNumber: entry.segmentNumber },
    orderBy: { startedAt: "desc" },
  });
  const activationSince = currentSegment?.startedAt ?? null;
  const alreadyFired = await prisma.traceEvent.findFirst({
    where: {
      entryId,
      eventType: "PRE_ARRIVAL.ACTIVATION_FIRED",
      ...(activationSince ? { timestamp: { gte: activationSince } } : {}),
    },
    orderBy: { timestamp: "desc" },
  });
  if (alreadyFired) return { skipped: true, reason: "ALREADY_FIRED" } as const;

  // The guest's answer to the CONFIRMATION VOUCHER must be on record before the booking moves
  // to pre-arrival (2026-08-07, operator ruling — extends the proforma answer-before-freeze
  // rule one stage up): the voucher went out at confirmation asking "is this booking right?",
  // and arrival prep starts on a yes. Segment-scoped like every communication gate; OTA
  // bookings auto-acknowledge at dispatch and pass. TIMED_OUT does not satisfy — capture the
  // late answer (p52 allows it), then activate. Skip (not throw): this is also the automatic
  // W4 path, and pg-boss must not retry-and-fail forever; the manual /activate-pre-arrival
  // route surfaces the message.
  const voucherComm = await prisma.communicationRecord.findFirst({
    where: {
      entryId,
      commType: "CONFIRMATION_VOUCHER",
      direction: "OUTBOUND",
      sendStatus: "DISPATCHED",
      ...(activationSince ? { createdAt: { gte: activationSince } } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: { acknowledgementStatus: true },
  });
  if (!voucherComm || voucherComm.acknowledgementStatus !== "RECEIVED") {
    return {
      skipped: true,
      reason: "VOUCHER_ANSWER_MISSING",
      detail: {
        voucherDispatched: !!voucherComm,
        message: !voucherComm
          ? "The confirmation voucher hasn't been sent this segment — send it to the guest, record their answer, then open Arrival."
          : "Record the guest's answer to the confirmation voucher first — the voucher went out at confirmation; their reply (verbal or written) is captured on the Confirm step.",
      },
    } as const;
  }

  const s4Dwell = await prisma.stageDwellRecord.findFirst({ where: { entryId, stage: Stage.S4, exitedAt: null }, orderBy: { enteredAt: "desc" } });
  // Policy registry override: admin-editable `registry.noShow.graceMinutes` row takes precedence
  // over the legacy `noShow.cutoffWindowMinutes` ConfigurationEntry. Set `enabled: false` on the
  // registry row to disable the override and revert to the ConfigurationEntry value.
  const noShowPolicy = await getRegistryPolicy(prisma, "registry.noShow.graceMinutes");
  const registryGraceMinutes =
    noShowPolicy && noShowPolicy.enabled !== false && typeof noShowPolicy.graceMinutes === "number"
      ? (noShowPolicy.graceMinutes as number)
      : null;
  const cutoffWindowMinutes =
    registryGraceMinutes ?? (await requireActiveConfigValue<number>(prisma, "noShow.cutoffWindowMinutes", { now }));
  const expectedArrival = entry.reservation?.frozenCheckInDate ?? entry.checkInDate;
  const cutoffAt = expectedArrival ? new Date(expectedArrival.getTime() + cutoffWindowMinutes * 60_000) : null;

  await prisma.$transaction(async (tx) => {
    if (s4Dwell) await tx.stageDwellRecord.update({ where: { id: s4Dwell.id }, data: { exitedAt: now, dwellSeconds: Math.floor((now.getTime() - s4Dwell.enteredAt.getTime()) / 1000) } as any });
    await tx.stageDwellRecord.create({ data: { entryId, stage: Stage.S5, enteredAt: now } });
    await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S5, version: { increment: 1 }, updatedAt: now } });

    // Mark the pre-arrival countdown as FIRED now that it has done its job (S5 is activating).
    // The pg-boss job payload is only `{ entryId }` (no timerRecordId), so the specific-id update
    // below never matched on the timer-fired path — leaving the W4 timer SCHEDULED with a past
    // firesAt, i.e. a phantom "overdue" countdown for the whole of S5 (until S5→S6 cancels it).
    // Mark ALL scheduled W4 timers for this entry FIRED so the desk countdown clears immediately.
    // Especially visible in compressed mode (same/next-day arrival, SIG-S5 §93) where firesAt is
    // clamped to ~now and the timer would otherwise read overdue the instant it fires.
    await tx.timerRecord.updateMany({
      where: { entryId, timerCode: "PRE_ARRIVAL_COUNTDOWN_W4", status: "SCHEDULED" },
      data: { status: "FIRED", firedAt: now },
    });
    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } });
    }

    // Cancel any pending W34 follow-up timers (responsibility transfers to S5 readiness).
    const w34Timers = await tx.timerRecord.findMany({
      where: { entryId, timerCode: "ADVANCE_PAYMENT_FOLLOW_UP_W34", status: "SCHEDULED" },
      orderBy: { createdAt: "desc" },
      take: 25,
    });
    await tx.timerRecord.updateMany({
      where: { id: { in: w34Timers.map((t) => t.id) }, status: "SCHEDULED" },
      data: { status: "CANCELLED", cancelledAt: now, cancelledBy: "SYSTEM", cancelledReason: "S4→S5 activation transfers follow-up to S5 readiness" },
    });

    await tx.traceEvent.create({
      data: {
        eventType: "PRE_ARRIVAL.ACTIVATION_FIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Entry",
        entityId: entryId,
        operation: "TRANSITION",
        timestamp: now,
        stageContext: Stage.S4,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          entryId,
          from: "S4",
          to: "S5",
          noShowCutoffMinutes: cutoffWindowMinutes,
          noShowGraceSource: registryGraceMinutes !== null ? "policy_registry" : "configuration_entry",
        },
        createdBy: "SYSTEM",
      },
    });
  });

  // Best-effort cancel scheduled jobs for W34.
  const w34ToCancel = await prisma.timerRecord.findMany({
    where: { entryId, timerCode: "ADVANCE_PAYMENT_FOLLOW_UP_W34", status: "CANCELLED", cancelledAt: { gte: new Date(now.getTime() - 60_000) } },
    orderBy: { createdAt: "desc" },
    take: 25,
  });
  for (const t of w34ToCancel) {
    if (t.pgBossJobId) await engine.cancel(t.pgBossJobId);
  }

  // Seed pre-arrival task checklist (idempotent), then reset any task completed during S4
  // prep back to PENDING (2026-08-10 operator ruling): the S4 "Handoff to front desk" section
  // is prep, not arrival verification — the Arrival checklist starts in its default state.
  // Runs once per activation (the ALREADY_FIRED guard above), so tasks completed AT S5 are
  // never touched. The S4 completions live on in the reset trace.
  await preArrivalService.initialiseTasks(prisma, entryId, "SYSTEM");
  if (!opts?.skipTaskReset) {
    await preArrivalService.resetTasksForArrivalVerification(prisma, entryId, "SYSTEM");
  }

  await scheduleS5StageDwellWarningMonitor(prisma, entryId, "SYSTEM");

  // Optional H1 auto-accept when configured as "same team" (SIG-S5 AC-S5-012).
  // Bubble errors — a swallowed catch here silently disabled same-team auto-accept on any DB blip
  // and required manual H1 acceptance the operator wouldn't know was needed.
  const auto = await requireActiveConfigValue<boolean | null>(prisma, "handoff.H1.autoFulfil.enabled", { now });
  if (auto) {
    const h1 = await prisma.handoffRecord.findFirst({ where: { entryId, handoffType: "H1" }, orderBy: { createdAt: "desc" } });
    if (h1 && h1.state === "CREATED") {
      await prisma.handoffRecord.update({
        where: { id: h1.id },
        data: { state: "ACCEPTED", acceptedAt: now, acceptedBy: "SYSTEM", isAutoFulfilled: true },
      });
    }
  }

  // Register no-show cutoff timer (idempotent on TimerRecord; schedule is best-effort).
  if (cutoffAt) {
    const existing = await prisma.timerRecord.findFirst({
      where: { entryId, timerCode: "NO_SHOW_CUTOFF_W5", status: "SCHEDULED" },
      orderBy: { createdAt: "desc" },
    });
    if (!existing) {
      const jobId = await engine.schedule("NO_SHOW_CUTOFF_W5", { entryId }, { startAfter: cutoffAt });
      await prisma.timerRecord.create({
        data: {
          entryId,
          entityType: "Entry",
          entityId: entryId,
          timerType: "NO_SHOW_CUTOFF_W5",
          timerCode: "NO_SHOW_CUTOFF_W5",
          stageContext: Stage.S5,
          firesAt: cutoffAt,
          dueAt: cutoffAt,
          status: "SCHEDULED",
          payload: { entryId, cutoffAt: cutoffAt.toISOString() },
          pgBossJobId: jobId,
          createdBy: "SYSTEM",
        },
      });
    }
  }

  return { skipped: false, entryId } as const;
}

