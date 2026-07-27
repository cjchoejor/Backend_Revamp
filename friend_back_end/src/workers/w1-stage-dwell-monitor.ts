import type { PrismaClient } from "@prisma/client";
import { StageDwellMode } from "@prisma/client";
import { requireActiveConfigValue } from "../lib/config-store.js";
import { getTimerEngine } from "../services/infrastructure/timer-management-service.js";
import * as notificationService from "../services/infrastructure/notification-service.js";
import * as auditService from "../services/infrastructure/audit-service.js";

type ThresholdConfig = Record<
  string,
  Partial<Record<StageDwellMode, { warning: number; critical: number; escalation: number }>>
>;

export async function runStageDwellMonitor(prisma: PrismaClient, input: { entryId: string }) {
  const entry = await prisma.entry.findUnique({
    where: { id: input.entryId },
    include: { availabilityConfigs: { where: { sealedAt: null }, orderBy: { createdAt: "desc" }, take: 25 } },
  });
  if (!entry) return { skipped: true, reason: "ENTRY_NOT_FOUND" } as const;

  const stage = entry.currentStage;
  const now = new Date();

  const dwell = await prisma.stageDwellRecord.findFirst({
    where: { entryId: entry.id, stage, exitedAt: null },
    orderBy: { enteredAt: "desc" },
  });
  if (!dwell) return { skipped: true, reason: "NO_ACTIVE_DWELL_RECORD" } as const;

  const thresholds = await requireActiveConfigValue<ThresholdConfig>(prisma, "stageDwell.thresholds", { now });
  const stageCfg = thresholds[String(stage)] ?? {};
  const modeCfg = stageCfg[dwell.mode] ?? stageCfg[StageDwellMode.ACTIVE];
  if (!modeCfg) return { skipped: true, reason: "NO_THRESHOLDS" } as const;

  const secondsInStage = Math.floor((now.getTime() - dwell.enteredAt.getTime()) / 1000);

  // Idempotency phases via timestamps on StageDwellRecord.
  const shouldWarn = secondsInStage >= modeCfg.warning && !dwell.warningFiredAt;
  const shouldCritical = secondsInStage >= modeCfg.critical && !dwell.criticalFiredAt;
  const shouldEscalate = secondsInStage >= modeCfg.escalation && !dwell.escalatedAt;

  // Availability staleness marking (SIG-S1 §7.1)
  const stalenessTtlSeconds = await requireActiveConfigValue<number>(prisma, "availability.staleness.ttlSeconds", { now });
  const staleCutoff = new Date(now.getTime() - stalenessTtlSeconds * 1000);
  const staleCfgs = entry.availabilityConfigs.filter((c) => !c.isStale && c.createdAt < staleCutoff);

  await prisma.$transaction(async (tx) => {
    if (shouldWarn) {
      await tx.stageDwellRecord.update({ where: { id: dwell.id }, data: { warningFiredAt: now, lastActiveAt: now } });
      await auditService.emit(tx as any, auditService.systemActor(), {
        eventType: "STAGE_DWELL.WARNING_FIRED",
        entityType: "Entry",
        entityId: entry.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: stage as any,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: { entryId: entry.id, stage, secondsInStage, mode: dwell.mode },
        createdBy: "SYSTEM",
      });
    }
    if (shouldCritical) {
      await tx.stageDwellRecord.update({ where: { id: dwell.id }, data: { criticalFiredAt: now, lastActiveAt: now } });
      await auditService.emit(tx as any, auditService.systemActor(), {
        eventType: "STAGE_DWELL.CRITICAL_FIRED",
        entityType: "Entry",
        entityId: entry.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: stage as any,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: { entryId: entry.id, stage, secondsInStage, mode: dwell.mode },
        createdBy: "SYSTEM",
      });
    }
    if (shouldEscalate) {
      await tx.stageDwellRecord.update({ where: { id: dwell.id }, data: { escalatedAt: now, lastActiveAt: now } });
      await auditService.emit(tx as any, auditService.systemActor(), {
        eventType: "STAGE_DWELL.FOM_ESCALATED",
        entityType: "Entry",
        entityId: entry.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: stage as any,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: { entryId: entry.id, stage, secondsInStage, mode: dwell.mode },
        createdBy: "SYSTEM",
      });
    }

    for (const cfg of staleCfgs) {
      await tx.availabilityConfiguration.update({
        where: { id: cfg.id },
        data: { isStale: true, stalenessAt: now },
      });
      await auditService.emit(tx as any, auditService.systemActor(), {
        eventType: "STAGE_DWELL.AVAILABILITY_STALENESS_MARKED",
        entityType: "AvailabilityConfiguration",
        entityId: cfg.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: stage as any,
        inquiryId: entry.inquiryId,
        entryId: entry.id,
        payload: { entryId: entry.id, configurationId: cfg.id, stalenessAt: now.toISOString() },
        createdBy: "SYSTEM",
      });
    }
  });

  if (shouldWarn) {
    await notificationService.dispatchStageDwell(prisma, {
      entryId: entry.id,
      stage: String(stage),
      severity: "WARNING",
      secondsInStage,
      mode: String(dwell.mode),
    });
  }
  if (shouldCritical) {
    await notificationService.dispatchStageDwell(prisma, {
      entryId: entry.id,
      stage: String(stage),
      severity: "CRITICAL",
      secondsInStage,
      mode: String(dwell.mode),
    });
  }
  if (shouldEscalate) {
    await notificationService.dispatchStageDwell(prisma, {
      entryId: entry.id,
      stage: String(stage),
      severity: "ESCALATION",
      secondsInStage,
      mode: String(dwell.mode),
    });
  }

  // --- Re-arm for the next un-fired phase ------------------------------------
  // The dwell monitor is scheduled once (at the WARNING horizon). Without
  // re-arming, only the warning ever fires and the CRITICAL / ESCALATION phases
  // are unreachable. Retire the monitor record that just fired (so it doesn't
  // linger as a phantom "SCHEDULED/overdue" timer — there is exactly one active
  // per entry+stage) and schedule the next check at the next un-fired horizon.
  const criticalDone = Boolean(dwell.criticalFiredAt) || shouldCritical;
  const escalatedDone = Boolean(dwell.escalatedAt) || shouldEscalate;

  let nextPhase: "CRITICAL" | "ESCALATION" | null = null;
  let nextHorizonSec: number | null = null;
  if (!criticalDone) {
    nextPhase = "CRITICAL";
    nextHorizonSec = modeCfg.critical;
  } else if (!escalatedDone) {
    nextPhase = "ESCALATION";
    nextHorizonSec = modeCfg.escalation;
  }

  // Capture the currently-scheduled monitor record ids first, so the FIRED
  // update below cannot accidentally retire the fresh record we create next.
  const priorMonitors = await prisma.timerRecord.findMany({
    where: { entryId: entry.id, timerCode: "STAGE_DWELL_MONITOR", stageContext: stage as any, status: "SCHEDULED" },
    select: { id: true },
  });
  if (priorMonitors.length) {
    await prisma.timerRecord.updateMany({
      where: { id: { in: priorMonitors.map((m) => m.id) } },
      data: { status: "FIRED", firedAt: now },
    });
  }

  if (nextPhase && nextHorizonSec != null) {
    // Never schedule in the past; floor at now+1s so a slightly-early pg-boss
    // wake-up (before the horizon) simply re-checks a moment later and converges.
    const nextFireAt = new Date(Math.max(dwell.enteredAt.getTime() + nextHorizonSec * 1000, now.getTime() + 1000));
    const engine = await getTimerEngine();
    const pgBossJobId = await engine.schedule("STAGE_DWELL_MONITOR", { entryId: entry.id }, { startAfter: nextFireAt });
    await prisma.timerRecord.create({
      data: {
        entryId: entry.id,
        entityType: "Entry",
        entityId: entry.id,
        timerType: "STAGE_DWELL_MONITOR",
        timerCode: "STAGE_DWELL_MONITOR",
        stageContext: stage as any,
        dueAt: nextFireAt,
        firesAt: nextFireAt,
        status: "SCHEDULED",
        createdBy: "SYSTEM",
        pgBossJobId,
        payload: { entryId: entry.id, stage: String(stage), dwellPhase: `${nextPhase}_WINDOW` },
      },
    });
  }

  return {
    skipped: false,
    phases: { warned: shouldWarn, critical: shouldCritical, escalated: shouldEscalate },
    staleMarked: staleCfgs.length,
    reArmed: nextPhase,
  } as const;
}

