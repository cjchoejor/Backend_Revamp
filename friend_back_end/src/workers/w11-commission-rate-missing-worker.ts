import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

/**
 * W11 — Escalate missing commission basis/rate resolution.
 * Implements AC-S9-024/025.
 */
export async function runCommissionRateMissingWorker(prisma: PrismaClient, input: { commissionDueId: string }) {
  const due = await prisma.commissionDueRecord.findUnique({ where: { id: input.commissionDueId } });
  if (!due) return { skipped: true, reason: "COMMISSION_DUE_NOT_FOUND" } as const;

  if (due.status !== "RATE_MISSING") return { skipped: true, reason: "NOT_RATE_MISSING" } as const;

  const timer = await prisma.timerRecord.findFirst({
    where: { entityType: "CommissionDueRecord", entityId: due.id, timerCode: "COMMISSION_RATE_MISSING_W11", status: "SCHEDULED" },
    orderBy: { createdAt: "desc" },
  });
  const now = new Date();
  if (timer) await prisma.timerRecord.update({ where: { id: timer.id }, data: { status: "FIRED", firedAt: now } as any });

  await (prisma as any).traceEvent.create({
    data: {
      eventType: "COMMISSION_DUE.RATE_MISSING_ESCALATION_FIRED",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "CommissionDueRecord",
      entityId: due.id,
      operation: "ALERT",
      timestamp: now,
      stageContext: Stage.S9,
      inquiryId: null,
      entryId: due.entryId,
      payload: { commissionDueId: due.id, entryId: due.entryId },
      createdBy: "SYSTEM",
    },
  });
  return { skipped: false, commissionDueId: due.id } as const;
}

