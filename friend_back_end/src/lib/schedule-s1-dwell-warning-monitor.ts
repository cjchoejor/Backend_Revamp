import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { requireActiveConfigValue } from "./config-store.js";
import { getTimerEngine } from "../services/infrastructure/timer-management-service.js";
import { cancelEntryTimersByCode } from "./cancel-entry-timers-by-code.js";

type ThresholdRow = Partial<
  Record<string, Partial<Record<"ACTIVE" | "IDLE" | "PARKED", { warning: number; critical: number; escalation: number }>>>
>;

/**
 * When an entry ENTERS **S1** (at creation), schedule W1's first check at the configured
 * **S1 / ACTIVE / warning** horizon. SIG-S1 §1181-1208 mandates `StageDwellMonitor` (W1) be
 * active at S1 (warning → critical → FOM escalation, plus availability-staleness marking); the
 * S2–S7 stages already arm this via their own `scheduleS{n}StageDwellWarningMonitor`, but S1 did
 * not, leaving the seeded `stageDwell.thresholds.S1` inert. W1 re-arms itself for the critical /
 * escalation phases once it fires.
 */
export async function scheduleS1StageDwellWarningMonitor(prisma: PrismaClient, entryId: string, createdByActorId: string) {
  const thresholds = await requireActiveConfigValue<ThresholdRow>(prisma, "stageDwell.thresholds").catch(() => ({} as ThresholdRow));
  const warnSec = Math.max(60, Number((thresholds as { S1?: { ACTIVE?: { warning?: number } } }).S1?.ACTIVE?.warning ?? 600));
  const firesAt = new Date(Date.now() + warnSec * 1000);
  // Supersede any prior STAGE_DWELL_MONITOR for this entry so exactly one is active. (A brand-new
  // entry has none, but keeping the guard matches the S2–S7 schedulers.)
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
      stageContext: Stage.S1,
      dueAt: firesAt,
      firesAt,
      status: "SCHEDULED",
      createdBy: createdByActorId,
      pgBossJobId,
      payload: { entryId, stage: "S1", dwellPhase: "WARNING_WINDOW" },
    },
  });
}
