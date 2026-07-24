import type { PrismaClient } from "@prisma/client";

/** Atlas Cat 06 group 04 (§5.2.4) — P12 duplicate flag on inquiry. */
export async function recordDuplicateDetectionFlagIfPresent(
  tx: PrismaClient,
  input: { inquiryId: string; actorId: string; conflictingInquiryId?: string | null } | null | undefined,
) {
  if (!input) return;

  await (tx as any).duplicateDetectionFlag.create({
    data: {
      inquiryId: input.inquiryId,
      status: "OPEN",
      resolutionReason: null,
      mergedIntoInquiryId: input.conflictingInquiryId ?? null,
      createdBy: input.actorId,
    },
  });

  await tx.traceEvent.create({
    data: {
      eventType: "INQUIRY.DUPLICATE_FLAGGED",
      actorId: input.actorId,
      actorLevel: "L1",
      entityType: "Inquiry",
      entityId: input.inquiryId,
      operation: "UPDATE",
      timestamp: new Date(),
      inquiryId: input.inquiryId,
      payload: { conflictingInquiryId: input.conflictingInquiryId ?? null },
      createdBy: input.actorId,
    },
  });
}
