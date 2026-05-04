import type { PrismaClient } from "@prisma/client";
import { FolioState, Stage } from "@prisma/client";

/**
 * W8 — Payment follow-up (post-stay).
 *
 * In this repo slice, W8 is implemented as a timer-fired audit/communication trigger:
 * - marks TimerRecord FIRED (if timerRecordId provided)
 * - emits a TraceEvent to prove the governed follow-up fired
 *
 * The full multi-interval escalation logic described in SIG docs can be layered on top of this base.
 */
export async function runPaymentFollowUpWorker(
  prisma: PrismaClient,
  input: { entryId?: string; folioId?: string; timerRecordId?: string; phase?: string },
) {
  const now = new Date();
  const entryId = typeof input.entryId === "string" ? input.entryId : undefined;
  if (!entryId) return { skipped: true, reason: "MISSING_ENTRY_ID" } as const;

  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true } });
  if (!entry || !entry.folio) return { skipped: true, reason: "ENTRY_OR_FOLIO_NOT_FOUND" } as const;
  const folio = entry.folio;

  // Only meaningful for OUTSTANDING folios at/after S9.
  if (entry.currentStage !== Stage.S9) return { skipped: true, reason: "NOT_AT_S9" } as const;
  if (folio.state !== FolioState.OUTSTANDING) return { skipped: true, reason: "FOLIO_NOT_OUTSTANDING" } as const;

  await prisma.$transaction(async (tx) => {
    if (typeof input.timerRecordId === "string") {
      await tx.timerRecord.updateMany({
        where: { id: input.timerRecordId, status: "SCHEDULED" },
        data: { status: "FIRED", firedAt: now } as any,
      });
    }

    await tx.traceEvent.create({
      data: {
        eventType: "PAYMENT_FOLLOW_UP.FIRED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "Entry",
        entityId: entryId,
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S9,
        inquiryId: entry.inquiryId,
        entryId,
        payload: {
          entryId,
          folioId: folio.id,
          outstandingBalance: folio.outstandingBalance.toString(),
          phase: typeof input.phase === "string" ? input.phase : "DEFAULT",
        },
        createdBy: "SYSTEM",
      },
    });
  });

  return { skipped: false, entryId } as const;
}

