import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { getActiveConfigEntry } from "./config-store.js";
import { getTimerEngine } from "../services/infrastructure/timer-management-service.js";

type DisputeSlaConfig = {
  firstResponseDueMinutes?: number;
  resolutionReminderMinutes?: number;
};

function clampMinutes(n: number, fallback: number) {
  const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  return Math.min(Math.max(v, 1), 525600);
}

/**
 * Registers **DISPUTE_SLA_W27** pg-boss jobs + `TimerRecord` rows when a dispute opens (SIG-S7 W27).
 * Best-effort: callers should not fail dispute creation if scheduling fails.
 */
export async function scheduleDisputeSlaW27Timers(
  prisma: PrismaClient,
  args: { disputeId: string; entryId: string; actorId: string; openedAt: Date },
) {
  const row = await getActiveConfigEntry(prisma, "dispute.sla");
  const cfg = (row?.configValue ?? {}) as DisputeSlaConfig;
  const firstMin = clampMinutes(Number(cfg.firstResponseDueMinutes), 240);
  const resolutionMin = Number(cfg.resolutionReminderMinutes);
  const hasSecond = Number.isFinite(resolutionMin) && resolutionMin > firstMin;

  const entry = await prisma.entry.findUnique({ where: { id: args.entryId }, select: { currentStage: true } });
  const stageContext = entry?.currentStage ?? Stage.S7;

  const engine = await getTimerEngine();
  const now = args.openedAt;

  const scheduleOne = async (dueAt: Date, phase: "FIRST_RESPONSE" | "RESOLUTION_REMINDER") => {
    const timerRecordId = randomUUID();
    const jobId = await engine.schedule(
      "DISPUTE_SLA_W27",
      { entryId: args.entryId, disputeId: args.disputeId, timerRecordId, phase },
      { startAfter: dueAt },
    );
    await prisma.timerRecord.create({
      data: {
        id: timerRecordId,
        entryId: args.entryId,
        entityType: "DisputeRecord",
        entityId: args.disputeId,
        timerType: "DISPUTE_SLA_W27",
        timerCode: "DISPUTE_SLA_W27",
        stageContext,
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: args.actorId,
        payload: { disputeId: args.disputeId, entryId: args.entryId, phase },
      },
    });
  };

  await scheduleOne(new Date(now.getTime() + firstMin * 60_000), "FIRST_RESPONSE");
  if (hasSecond) {
    await scheduleOne(new Date(now.getTime() + clampMinutes(resolutionMin, firstMin + 1) * 60_000), "RESOLUTION_REMINDER");
  }
}

export async function cancelDisputeSlaW27Timers(
  prisma: PrismaClient,
  disputeId: string,
  cancelledBy: string,
  cancelledReason: string,
) {
  const timers = await prisma.timerRecord.findMany({
    where: { entityType: "DisputeRecord", entityId: disputeId, timerCode: "DISPUTE_SLA_W27", status: "SCHEDULED" },
  });
  if (!timers.length) return;
  const engine = await getTimerEngine();
  const now = new Date();
  await Promise.all(timers.map((t) => (t.pgBossJobId ? engine.cancel(t.pgBossJobId) : Promise.resolve())));
  await prisma.timerRecord.updateMany({
    where: { id: { in: timers.map((t) => t.id) } },
    data: { status: "CANCELLED", cancelledAt: now, cancelledBy, cancelledReason },
  });
}
