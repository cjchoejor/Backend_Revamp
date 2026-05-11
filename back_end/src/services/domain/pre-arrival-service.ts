import type { PrismaClient } from "@prisma/client";
import { PreArrivalTaskType, TaskCategory, TaskStatus } from "@prisma/client";
import { NotFoundError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { enforcePreArrivalTaskWaiveRequiresReason } from "../../policies/03-expiry-parking/p09-s5-normal-exit-pre-arrival-tasks-terminal.js";

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

  if (task.status !== TaskStatus.PENDING) {
    throw new StateTransitionError("Task is already in a terminal status");
  }

  if (action === "WAIVE") {
    enforcePreArrivalTaskWaiveRequiresReason({ action, waivedReason });
    return prisma.preArrivalTask.update({
      where: { id: taskId },
      data: {
        status: TaskStatus.WAIVED,
        waivedReason: waivedReason!.trim(),
        waivedBy: actorId,
      },
    });
  }

  return prisma.preArrivalTask.update({
    where: { id: taskId },
    data: {
      status: TaskStatus.COMPLETE,
      completedAt: new Date(),
      completedBy: actorId,
    },
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
