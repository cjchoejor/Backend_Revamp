import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../lib/errors.js";
import { enforceNoOpenDuplicateFlagsForS2Exit } from "../policies/04-duplicate-detection/p12-open-duplicate-flag-blocks-s2-exit.js";
import { enforceQuotationValidityNotLapsedForS2Exit } from "../policies/08-pricing-rate-plan/p07-quotation-validity-not-lapsed-for-s2-exit.js";
import { enforceDiscountApprovalBeforeSend } from "../policies/09-discount/p23-discount-send-requires-approval.js";
import { enforceSpeculativeHoldActiveForS2Exit } from "../policies/10-speculative-hold/p25-speculative-hold-active-for-s2-exit.js";
import { enforceQuotationAckOpenLoopResolvedForS2Exit } from "../policies/20-communication-acknowledgement-tracking/p52-quotation-ack-open-loop-resolved-for-s2-exit.js";
import { enforceAcceptedQuotationPresentForS2Exit } from "../policies/08-pricing-rate-plan/p07-quotation-validity-not-lapsed-for-s2-exit.js";
import { enforceEntryAtS2ForS2ToS3Progression } from "../policies/01-availability/p01-entry-progression-stage-gates.js";
import { getOrCreateProvisionalFolioTx } from "../services/domain/s3-folio-service.js";
import { scheduleS3StageDwellWarningMonitor } from "../lib/schedule-s3-dwell-warning-monitor.js";

export async function progressS2ToS3(prisma: PrismaClient, entryId: string, _actorId: string, clientVersion: number | undefined) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      inquiry: { include: { duplicateFlags: true } as any },
      quotations: true,
      segments: { orderBy: { segmentNumber: "desc" }, take: 1 },
      folio: true,
      speculativeHolds: true,
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS2ForS2ToS3Progression({ currentStage: entry.currentStage });
  if (clientVersion == null) throw new ValidationError("version is required");
  if (entry.version !== clientVersion) throw new ValidationError("version mismatch");

  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  const acceptedCfg = entry.quotations.find((q) => q.segmentId === segmentId && q.state === "ACCEPTED");
  enforceAcceptedQuotationPresentForS2Exit({ hasAcceptedQuotation: !!acceptedCfg });
  const accepted = acceptedCfg!;

  enforceQuotationValidityNotLapsedForS2Exit({ validUntil: accepted.validUntil });

  const discount = (accepted.commercialTerms as any)?.requestedDiscount;
  await enforceDiscountApprovalBeforeSend(prisma, { quotationId: accepted.id, hasDiscount: !!discount });

  enforceNoOpenDuplicateFlagsForS2Exit({ duplicateFlags: (entry.inquiry as any)?.duplicateFlags });

  const segHolds = (entry.speculativeHolds ?? []).filter((h) => (h as any).segmentId === segmentId);
  enforceSpeculativeHoldActiveForS2Exit({ segmentHolds: segHolds as any });

  await enforceQuotationAckOpenLoopResolvedForS2Exit(prisma, { quotationId: accepted.id });

  const updated = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const s2Dwell = await tx.stageDwellRecord.findFirst({
      where: { entryId, stage: Stage.S2, exitedAt: null },
      orderBy: { enteredAt: "desc" },
    });
    if (s2Dwell) {
      await tx.stageDwellRecord.update({
        where: { id: s2Dwell.id },
        data: {
          exitedAt: now,
          dwellSeconds: Math.max(0, Math.floor((now.getTime() - s2Dwell.enteredAt.getTime()) / 1000)),
        },
      });
    }
    await tx.stageDwellRecord.create({
      data: { entryId, stage: Stage.S3, enteredAt: now, lastActiveAt: now, mode: "ACTIVE" } as any,
    });

    await tx.quotation.updateMany({
      where: { entryId, segmentId, sealedAt: null },
      data: { sealedAt: now },
    });

    await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S3, version: { increment: 1 } } });

    await getOrCreateProvisionalFolioTx(tx, entryId, segmentId, _actorId, entry.inquiryId, now);

    return tx.entry.findUniqueOrThrow({ where: { id: entryId } });
  });

  await scheduleS3StageDwellWarningMonitor(prisma, entryId, _actorId);

  return updated;
}
