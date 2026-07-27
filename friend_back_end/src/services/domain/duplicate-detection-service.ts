import type { PrismaClient } from "@prisma/client";
import { ValidationError } from "../../lib/errors.js";
import { assertNoConfirmedDuplicateInquiryForCreation } from "../../policies/04-duplicate-detection/p12-inquiry-duplicate-at-creation.js";
import { recordDuplicateDetectionFlagIfPresent } from "../../policies/04-duplicate-detection/p12-duplicate-flag-create-on-inquiry.js";

export async function assertInquiryNotConfirmedDuplicateForCreation(
  prisma: PrismaClient,
  input: { guestProfileId: string; proposedCheckIn?: string; proposedCheckOut?: string },
) {
  return assertNoConfirmedDuplicateInquiryForCreation(prisma, input);
}

export async function maybeCreateDuplicateFlag(
  prisma: PrismaClient,
  input: { inquiryId: string; actorId: string; conflictingInquiryId: string | null },
) {
  return recordDuplicateDetectionFlagIfPresent(prisma as any, input);
}

export async function resolveDuplicateFlag(
  prisma: PrismaClient,
  flagId: string,
  actorId: string,
  input: { resolutionType: "MERGE" | "ACKNOWLEDGE" | "DISMISS"; resolutionReason?: string; mergedIntoInquiryId?: string },
) {
  if (!input.resolutionType) throw new ValidationError("resolutionType is required");
  const now = new Date();
  const flag = await (prisma as any).duplicateDetectionFlag.findUnique({ where: { id: flagId } });
  if (!flag) throw new ValidationError("DuplicateDetectionFlag not found");
  if (flag.status !== "OPEN") throw new ValidationError("DuplicateDetectionFlag is not OPEN");

  const updated = await (prisma as any).duplicateDetectionFlag.update({
    where: { id: flagId },
    data: {
      status: "RESOLVED",
      resolutionType: input.resolutionType,
      resolutionReason: input.resolutionReason?.trim?.() || null,
      mergedIntoInquiryId: input.mergedIntoInquiryId?.trim?.() || flag.mergedIntoInquiryId || null,
      resolvedAt: now,
      resolvedBy: actorId,
    },
  });
  await prisma.traceEvent.create({
    data: {
      eventType: "INQUIRY.DUPLICATE_RESOLVED",
      actorId,
      actorLevel: "L1",
      entityType: "DuplicateDetectionFlag",
      entityId: flagId,
      operation: "UPDATE",
      timestamp: now,
      inquiryId: updated.inquiryId,
      payload: { resolutionType: updated.resolutionType, resolutionReason: updated.resolutionReason, mergedIntoInquiryId: updated.mergedIntoInquiryId },
      createdBy: actorId,
    },
  });
  return updated;
}

