import { type Prisma, QuotationState, Stage } from "@prisma/client";

/**
 * Retire the outgoing segment's ACCEPTED quotation when a booking flows back to S2.
 *
 * WHY THIS EXISTS (2026-08-04)
 * ---------------------------
 * A backflow into S2 exists precisely because the agreed price is being renegotiated. But the
 * backflow only sealed the old segment and opened a new one — it left the previously ACCEPTED
 * quotation ACCEPTED. The booking then carried TWO (or more) live "agreed prices" at once.
 * Observed on ENT-20260728-0014, which accumulated three simultaneous ACCEPTED quotations
 * across three segments: 1,767.15 / 1,747.52 / 1,865.33.
 *
 * That is not merely untidy, because `versionNumber` RESTARTS AT 1 for each new segment. Once
 * more than one accepted quote exists, "highest version" stops meaning "most recent", and any
 * reader that sorts by version picks an arbitrary older one. The invoice PDF renderer did
 * exactly that and would have printed 1,747.52 on a booking whose real agreed price was
 * 1,865.33.
 *
 * It also produced the operator-visible symptom that led here: after re-entering S2 the old
 * quote could neither be sent (`Only DRAFT quotations can be sent`) nor superseded
 * (`Cannot supersede an ACCEPTED quotation`), leaving the desk stuck.
 *
 * Superseding here keeps the invariant the rest of the code already assumes: **at most one
 * live ACCEPTED quotation per entry.** The row is not deleted — it stays as the historical
 * record of what was agreed during that segment, exactly like a normal supersede.
 *
 * Deliberately NOT reused for the S2 supersede path: that one runs while still inside a
 * segment and is blocked on ACCEPTED by policy (`enforceQuotationSupersedeAllowedState`).
 * This is the stage-transition case, where retiring the accepted quote is the whole point.
 */
export async function supersedeAcceptedQuotationForBackflowToS2(
  tx: Prisma.TransactionClient,
  input: {
    entryId: string;
    /** Segment being sealed — the one whose accepted quote is now historical. */
    segmentId: string;
    actorId: string;
    actorLevel: string;
    /** e.g. "REENTRY_S3_TO_S2", "BACKFLOW_RATE_REVISION_S7_S2". */
    reason: string;
    inquiryId?: string | null;
    now?: Date;
  },
): Promise<{ supersededQuotationIds: string[] }> {
  const now = input.now ?? new Date();

  const accepted = await tx.quotation.findMany({
    where: { entryId: input.entryId, segmentId: input.segmentId, state: QuotationState.ACCEPTED },
    select: { id: true, versionNumber: true, totalAmount: true },
  });
  if (accepted.length === 0) return { supersededQuotationIds: [] };

  const ids = accepted.map((q) => q.id);

  await tx.quotation.updateMany({
    where: { id: { in: ids } },
    data: { state: QuotationState.SUPERSEDED, supersededAt: now },
  });

  await tx.traceEvent.create({
    data: {
      eventType: "QUOTATION.SUPERSEDED_ON_BACKFLOW",
      actorId: input.actorId,
      actorLevel: input.actorLevel as never,
      entityType: "Entry",
      entityId: input.entryId,
      operation: "UPDATE",
      timestamp: now,
      stageContext: Stage.S2,
      inquiryId: input.inquiryId ?? null,
      entryId: input.entryId,
      payload: {
        entryId: input.entryId,
        segmentId: input.segmentId,
        reason: input.reason,
        supersededQuotations: accepted.map((q) => ({
          quotationId: q.id,
          versionNumber: q.versionNumber,
          totalAmount: q.totalAmount?.toString() ?? null,
        })),
      },
      createdBy: input.actorId,
    },
  });

  return { supersededQuotationIds: ids };
}
