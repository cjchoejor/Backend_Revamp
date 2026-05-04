import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";

export async function runAdvancePaymentFollowUpWorker(prisma: PrismaClient, input: { entryId?: string; invoiceId?: string; tier?: 1 | 2; timerRecordId?: string }) {
  const now = new Date();
  const entryId = typeof input.entryId === "string" ? input.entryId : undefined;
  if (!entryId) return { skipped: true, reason: "MISSING_ENTRY_ID" } as const;

  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: { include: { payments: true } } } });
  if (!entry || !entry.folio) return { skipped: true, reason: "MISSING_ENTRY_OR_FOLIO" } as const;

  if (entry.status === "CANCELLED" || entry.status === "EXPIRED" || entry.currentStage === "S5" || entry.currentStage === "S6" || entry.currentStage === "S7" || entry.currentStage === "S8" || entry.currentStage === "S9") {
    return { skipped: true, reason: "NOT_APPLICABLE_STAGE_OR_STATUS" } as const;
  }

  const totalIn = (entry.folio.payments ?? []).filter((p) => p.paymentDirection === "IN").reduce((sum, p) => sum + Number(p.amount.toString()), 0);
  const credit = await prisma.creditExtensionCeilingRecord.findUnique({ where: { folioId: entry.folio.id } }).catch(() => null);
  if (credit || totalIn > 0) {
    await prisma.traceEvent.create({
      data: {
        eventType: "ADVANCE_PAYMENT.FOLLOW_UP_SKIPPED_CONDITION_MET",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Entry",
        entityId: entryId,
        operation: "SKIP",
        timestamp: now,
        stageContext: Stage.S3,
        entryId,
        payload: { entryId, totalIn, creditExtensionActive: !!credit },
        createdBy: "SYSTEM",
      },
    });
    return { skipped: true, reason: "CONDITION_MET" } as const;
  }

  const tier = input.tier === 2 ? 2 : 1;
  await prisma.traceEvent.create({
    data: {
      eventType: tier === 2 ? "ADVANCE_PAYMENT.ESCALATED_TO_FOM" : "ADVANCE_PAYMENT.FOLLOW_UP_SENT",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "Entry",
      entityId: entryId,
      operation: "ALERT",
      timestamp: now,
      stageContext: Stage.S3,
      entryId,
      payload: { entryId, invoiceId: input.invoiceId ?? null, tier },
      createdBy: "SYSTEM",
    },
  });

  if (typeof input.timerRecordId === "string") {
    await prisma.timerRecord.updateMany({ where: { id: input.timerRecordId, status: "SCHEDULED" }, data: { status: "FIRED", firedAt: now } });
  }

  return { skipped: false, entryId, tier } as const;
}

