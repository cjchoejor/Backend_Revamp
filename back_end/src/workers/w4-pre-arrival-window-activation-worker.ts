import type { PrismaClient } from "@prisma/client";
import { EntryStatus, Stage } from "@prisma/client";
import type { TimerEngine } from "../lib/timer-engine.js";
import { requireActiveConfigValue } from "../lib/config-store.js";
import * as preArrivalService from "../services/domain/pre-arrival-service.js";
import { armNoShowCutoff, noShowCutoffFor, resolveExpectedArrival, resolveNoShowGraceMinutes } from "../lib/expected-arrival.js";
import { enforceReservationSnapshotPresentForS5Activation } from "../policies/01-availability/p01-reservation-snapshot-required-for-s5-activation.js";
import { scheduleS5StageDwellWarningMonitor } from "../lib/schedule-s5-dwell-warning-monitor.js";
import { latestDispatchedInForce } from "../lib/reply-waits.js";

export async function runPreArrivalWindowActivationWorker(
  prisma: PrismaClient,
  engine: TimerEngine,
  input: { entryId?: string; timerRecordId?: string; fromTimer?: boolean },
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
  const result = await activate(prisma, engine, entryId, input, opts, now);
  // The countdown fired and could not open Arrival: its record is closed and says why, so the desk
  // does not show a clock "overdue" for good (2026-10-29). The desk moves the booking on once the
  // reason is put right.
  if (input.fromTimer && result.skipped && result.reason !== "ALREADY_FIRED") {
    const closed = await prisma.timerRecord.updateMany({
      where: { entryId, timerCode: "PRE_ARRIVAL_COUNTDOWN_W4", status: "SCHEDULED", firesAt: { lte: now } },
      data: { status: "FIRED", firedAt: now },
    });
    if (closed.count && result.reason !== "NOT_AT_S4") {
      await prisma.traceEvent
        .create({
          data: {
            eventType: "PRE_ARRIVAL.WINDOW_OPEN_WAITING",
            actorId: "SYSTEM",
            actorLevel: "SYSTEM" as never,
            entityType: "Entry",
            entityId: entryId,
            operation: "UPDATE",
            timestamp: now,
            stageContext: Stage.S4,
            entryId,
            payload: { entryId, reason: result.reason, message: (result as { detail?: { message?: string } }).detail?.message ?? null },
            createdBy: "SYSTEM",
          },
        })
        .catch(() => {});
    }
  }
  return result;
}

async function activate(
  prisma: PrismaClient,
  engine: TimerEngine,
  entryId: string,
  input: { entryId?: string; timerRecordId?: string; fromTimer?: boolean },
  opts: { skipTaskReset?: boolean } | undefined,
  now: Date,
) {

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

  // The guest's answer to the CONFIRMATION VOUCHER, when it went out (2026-08-07, operator ruling;
  // narrowed 2026-10-29: "sending the confirmation voucher is not mandatory, but if sent, the
  // reply is"). A voucher the desk held and never sent, or chose not to send, has nothing to
  // answer — the generate-vs-send rule the quotation and the proforma already follow. A voucher
  // that went out (by email or on WhatsApp) asked "is this booking right?", and arrival prep
  // starts on a yes. Segment-scoped like every communication gate; OTA bookings auto-acknowledge
  // at dispatch and pass. TIMED_OUT does not satisfy — capture the late answer (p52 allows it),
  // then activate. Skip (not throw): this is also the automatic W4 path, and pg-boss must not
  // retry-and-fail forever; the manual /activate-pre-arrival route surfaces the message.
  // The voucher in force — a replaced one's answer is never demanded (2026-10-13).
  const voucherComm = await latestDispatchedInForce(prisma, {
    entryId,
    commType: "CONFIRMATION_VOUCHER",
    since: activationSince ?? null,
  });
  if (voucherComm && voucherComm.acknowledgementStatus !== "RECEIVED") {
    return {
      skipped: true,
      reason: "VOUCHER_ANSWER_MISSING",
      detail: {
        voucherDispatched: true,
        message: "The confirmation voucher went to the guest — record their answer to it first, on the Reserve step, by message or as they told the desk.",
      },
    } as const;
  }

  const s4Dwell = await prisma.stageDwellRecord.findFirst({ where: { entryId, stage: Stage.S4, exitedAt: null }, orderBy: { enteredAt: "desc" } });
  // The no-show cut-off counts from the EXPECTED ARRIVAL — the guest's own time, else the hotel's
  // standard check-in time, on the check-in day in hotel time (2026-09-18; it counted from the
  // stored date's UTC midnight, 06:00 in Bhutan, so a guest due that afternoon was a no-show at
  // 08:00) — plus the grace (registry.noShow.graceMinutes, else noShow.cutoffWindowMinutes).
  const cutoffWindowMinutes = await resolveNoShowGraceMinutes(prisma);
  const expectedArrival = await resolveExpectedArrival(prisma, entry);
  // Never inside the grace of now: a same-day booking opened after its expected arrival gets the
  // grace from the moment it reaches Arrival, not a cut-off that already passed.
  // A change made at Arrival walks the booking back and returns it here (2026-10-29): it keeps the
  // cut-off it had for this same expected arrival — the guest is no later for the desk having moved
  // their room — and once that cut-off has fired, no new one is armed (a reactivation clears it on
  // purpose). Each change used to re-arm a fresh grace from that moment, pushing the cut-off later.
  const priorCutoff = expectedArrival.at
    ? await prisma.timerRecord.findFirst({
        where: { entryId, timerCode: "NO_SHOW_CUTOFF_W5", payload: { path: ["expectedAt"], equals: expectedArrival.at.toISOString() } },
        orderBy: { createdAt: "desc" },
        select: { status: true, dueAt: true },
      })
    : null;
  const cutoffAt = !expectedArrival.at
    ? null
    : priorCutoff?.status === "FIRED"
      ? null
      : priorCutoff
        ? priorCutoff.dueAt
        : noShowCutoffFor(expectedArrival.at, cutoffWindowMinutes, now);

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
          expectedArrival: expectedArrival.at?.toISOString() ?? null,
          expectedArrivalSource: expectedArrival.source,
          noShowCutoffAt: cutoffAt?.toISOString() ?? null,
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

  // Register the no-show cut-off (one live clock; the job carries its record id so W5 marks it).
  if (cutoffAt) {
    const existing = await prisma.timerRecord.findFirst({
      where: { entryId, timerCode: "NO_SHOW_CUTOFF_W5", status: "SCHEDULED" },
      orderBy: { createdAt: "desc" },
    });
    if (!existing) await armNoShowCutoff(prisma, entryId, cutoffAt, "SYSTEM", expectedArrival.at);
  }

  return { skipped: false, entryId } as const;
}

