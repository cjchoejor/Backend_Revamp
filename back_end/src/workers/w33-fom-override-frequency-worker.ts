import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { requireActiveConfigValue } from "../lib/config-store.js";

/**
 * AC-S8-21/22: ambient GM notice when override frequency exceeds threshold.
 */
export async function runFomOverrideFrequencyWorker(prisma: PrismaClient, input: { now?: Date } = {}) {
  const now = input.now ?? new Date();
  const cfg = (await requireActiveConfigValue<Record<string, number> | undefined>(prisma, "fomOverride.frequency")) ?? {};
  const rollingWindowDays = typeof cfg.rollingWindowDays === "number" ? cfg.rollingWindowDays : 7;
  const maxFrequency = typeof cfg.maxFrequency === "number" ? cfg.maxFrequency : 3;

  const since = new Date(now.getTime() - rollingWindowDays * 86400_000);
  const count = await prisma.disputeGateOverrideRecord.count({ where: { createdAt: { gte: since } } });

  if (count <= maxFrequency) return { skipped: true, reason: "UNDER_THRESHOLD", count, maxFrequency, rollingWindowDays } as const;

  await prisma.traceEvent.create({
    data: {
      eventType: "FOM_OVERRIDE_FREQUENCY.GM_NOTICE_SENT",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "DisputeGateOverrideRecord",
      entityId: "W33",
      operation: "ALERT",
      timestamp: now,
      stageContext: Stage.S8,
      inquiryId: null,
      entryId: null,
      payload: { rollingWindowDays, maxFrequency, count, since: since.toISOString() },
      createdBy: "SYSTEM",
    },
  });
  return { skipped: false, count, maxFrequency, rollingWindowDays } as const;
}

