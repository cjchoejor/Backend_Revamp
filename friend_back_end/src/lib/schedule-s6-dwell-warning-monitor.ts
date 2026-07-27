import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { requireActiveConfigValue } from "./config-store.js";
import { getTimerEngine } from "../services/infrastructure/timer-management-service.js";
import { cancelEntryTimersByCode } from "./cancel-entry-timers-by-code.js";

type ThresholdRow = Partial<
  Record<string, Partial<Record<"ACTIVE" | "IDLE" | "PARKED", { warning: number; critical: number; escalation: number }>>>
>;

/**
 * After **S5→S6** (check-in commencement), schedule W1’s first check at **S6 / ACTIVE / warning** (SIG-S6 §5.1).
 */
export async function scheduleS6StageDwellWarningMonitor(prisma: PrismaClient, entryId: string, createdByActorId: string) {
  const thresholds = await requireActiveConfigValue<ThresholdRow>(prisma, "stageDwell.thresholds").catch(() => ({} as ThresholdRow));
  const warnSec = Math.max(60, Number((thresholds as { S6?: { ACTIVE?: { warning?: number } } }).S6?.ACTIVE?.warning ?? 1800));
  const firesAt = new Date(Date.now() + warnSec * 1000);
  // Supersede any prior-stage dwell monitor for this entry so it doesn't linger as a phantom
  // "overdue" timer in the live feed once the entry has moved on. Exactly one STAGE_DWELL_MONITOR
  // should be active at a time (an entry is only ever in one stage).
  await cancelEntryTimersByCode(prisma, {
    entryId,
    timerCodes: ["STAGE_DWELL_MONITOR"],
    cancelledBy: createdByActorId,
    cancelledReason: "Superseded by new stage dwell monitor",
  });
  const engine = await getTimerEngine();
  const pgBossJobId = await engine.schedule("STAGE_DWELL_MONITOR", { entryId }, { startAfter: firesAt });
  await prisma.timerRecord.create({
    data: {
      entryId,
      entityType: "Entry",
      entityId: entryId,
      timerType: "STAGE_DWELL_MONITOR",
      timerCode: "STAGE_DWELL_MONITOR",
      stageContext: Stage.S6,
      dueAt: firesAt,
      firesAt,
      status: "SCHEDULED",
      createdBy: createdByActorId,
      pgBossJobId,
      payload: { entryId, stage: "S6", dwellPhase: "WARNING_WINDOW" },
    },
  });
}
