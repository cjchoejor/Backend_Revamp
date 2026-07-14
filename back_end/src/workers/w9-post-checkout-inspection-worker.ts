import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * AC-S8-24: When W9 fires after the inspection deferral window, emit an alert trace.
 * This slice records a TraceEvent only (no external notifications).
 */
export async function runPostCheckoutInspectionWorker(prisma: PrismaClient, input: { entryId: string }) {
  const entry = await prisma.entry.findUnique({ where: { id: input.entryId } });
  if (!entry) return { skipped: true, reason: "ENTRY_NOT_FOUND" } as const;

  const insp = await prisma.roomInspectionRecord.findFirst({ where: { entryId: input.entryId }, orderBy: { createdAt: "desc" } });
  if (!insp || insp.isDeferred !== true) return { skipped: true, reason: "NO_DEFERRED_INSPECTION" } as const;

  const timer = await prisma.timerRecord.findFirst({
    where: { entryId: input.entryId, timerCode: "POST_CHECKOUT_INSPECTION_W9", status: "SCHEDULED" },
    orderBy: { createdAt: "desc" },
  });
  if (!timer) return { skipped: true, reason: "NO_W9_TIMER" } as const;

  const now = new Date();
  // Race safety: updateMany with `status: "SCHEDULED"` filter. If a concurrent cancel already
  // moved this timer to CANCELLED between the findFirst and here, count === 0 and we skip the
  // trace — the caller who cancelled owns the outcome.
  const claimed = await prisma.timerRecord.updateMany({
    where: { id: timer.id, status: "SCHEDULED" },
    data: { status: "FIRED", firedAt: now } as any,
  });
  if (claimed.count === 0) return { skipped: true, reason: "TIMER_ALREADY_CLAIMED_OR_CANCELLED" } as const;
  await prisma.traceEvent.create({
    data: {
      eventType: "POST_CHECKOUT_INSPECTION.WINDOW_EXPIRED",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "Entry",
      entityId: input.entryId,
      operation: "ALERT",
      timestamp: now,
      stageContext: Stage.S8,
      inquiryId: entry.inquiryId,
      entryId: input.entryId,
      payload: { entryId: input.entryId, timerId: timer.id, dueAt: timer.dueAt.toISOString() },
      createdBy: "SYSTEM",
    },
  });
  return { skipped: false, timerId: timer.id } as const;
}

