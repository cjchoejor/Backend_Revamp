import type { PrismaClient } from "@prisma/client";
import { StageDwellMode } from "@prisma/client";
import { requireActiveConfigValue } from "../lib/config-store.js";
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

  return { skipped: false, phases: { warned: shouldWarn, critical: shouldCritical, escalated: shouldEscalate }, staleMarked: staleCfgs.length } as const;
}

