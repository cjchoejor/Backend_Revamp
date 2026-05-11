import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * AC-S7-07: after night audit COMPLETE, we must (at minimum) record that next-day
 * timers were recalculated. In this repo slice, we model this as an audit TraceEvent.
 */
export async function recalculateNextDayTimers(prisma: PrismaClient, actorId: string, input: { operatingDate: Date }) {
  const now = new Date();
  await prisma.traceEvent.create({
    data: {
      eventType: "TIMER_MANAGEMENT.RECALCULATE_NEXT_DAY_TIMERS_CALLED",
      actorId,
      actorLevel: "SYSTEM",
      entityType: "NightAuditRecord",
      entityId: input.operatingDate.toISOString(),
      operation: "ALERT",
      timestamp: now,
      stageContext: Stage.S7,
      inquiryId: null,
      entryId: null,
      payload: { operatingDate: input.operatingDate.toISOString() },
      createdBy: actorId,
    },
  });
  return { ok: true } as const;
}

