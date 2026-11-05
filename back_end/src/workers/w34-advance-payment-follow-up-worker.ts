import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { evaluateAdvancePaymentCondition } from "../services/domain/s3-payment-service.js";

export async function runAdvancePaymentFollowUpWorker(prisma: PrismaClient, input: { entryId?: string; invoiceId?: string; tier?: 1 | 2; timerRecordId?: string }) {
  const now = new Date();
  const entryId = typeof input.entryId === "string" ? input.entryId : undefined;
  if (!entryId) return { skipped: true, reason: "MISSING_ENTRY_ID" } as const;

  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: { include: { payments: true } } } });
  if (!entry || !entry.folio) return { skipped: true, reason: "MISSING_ENTRY_OR_FOLIO" } as const;

  if (entry.status === "CANCELLED" || entry.status === "EXPIRED" || entry.currentStage === "S5" || entry.currentStage === "S6" || entry.currentStage === "S7" || entry.currentStage === "S8" || entry.currentStage === "S9") {
    return { skipped: true, reason: "NOT_APPLICABLE_STAGE_OR_STATUS" } as const;
  }

  // Do NOT swallow errors here — a transient DB failure with a fallback of 0 would silently mark
  // every follow-up as satisfied and never nudge unpaid guests. Let pg-boss retry. The one rule the
  // gates read (2026-11-05), so what was set on this booking counts here too.
  const advance = await evaluateAdvancePaymentCondition(prisma, { entryId, folioId: entry.folio.id });
  const totalIn = advance.totalReceived;
  if (advance.satisfied) {
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
        payload: { entryId, totalIn, creditExtensionActive: advance.creditExtensionActive },
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

