import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
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
) {
  const now = new Date();
  const entryId = typeof input.entryId === "string" ? input.entryId : undefined;
  if (!entryId) return { skipped: true, reason: "MISSING_ENTRY_ID" } as const;

  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { reservation: true } });
  if (!entry) return { skipped: true, reason: "ENTRY_NOT_FOUND" } as const;
  if (entry.currentStage !== Stage.S4) return { skipped: true, reason: "NOT_AT_S4" } as const;
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

  // Seed pre-arrival task checklist (idempotent).
  await preArrivalService.initialiseTasks(prisma, entryId, "SYSTEM");

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

