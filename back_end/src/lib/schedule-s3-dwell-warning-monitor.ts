import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { requireActiveConfigValue } from "./config-store.js";
import { getTimerEngine } from "../services/infrastructure/timer-management-service.js";

type ThresholdRow = Partial<
  Record<string, Partial<Record<"ACTIVE" | "IDLE" | "PARKED", { warning: number; critical: number; escalation: number }>>>
>;

/**
 * After entering **S3** dwell, schedule W1’s first check at **S3 / ACTIVE / warning** (SIG-S3 §1.4 / §5.3).
 */
export async function scheduleS3StageDwellWarningMonitor(prisma: PrismaClient, entryId: string, createdByActorId: string) {
  const thresholds = await requireActiveConfigValue<ThresholdRow>(prisma, "stageDwell.thresholds").catch(() => ({} as ThresholdRow));
  const warnSec = Math.max(60, Number((thresholds as { S3?: { ACTIVE?: { warning?: number } } }).S3?.ACTIVE?.warning ?? 1800));
  const firesAt = new Date(Date.now() + warnSec * 1000);
  const engine = await getTimerEngine();
  const pgBossJobId = await engine.schedule("STAGE_DWELL_MONITOR", { entryId }, { startAfter: firesAt });
  await prisma.timerRecord.create({
    data: {
      entryId,
      entityType: "Entry",
      entityId: entryId,
      timerType: "STAGE_DWELL_MONITOR",
      timerCode: "STAGE_DWELL_MONITOR",
      stageContext: Stage.S3,
      dueAt: firesAt,
      firesAt,
      status: "SCHEDULED",
      createdBy: createdByActorId,
      pgBossJobId,
      payload: { entryId, stage: "S3", dwellPhase: "WARNING_WINDOW" },
    },
  });
}
