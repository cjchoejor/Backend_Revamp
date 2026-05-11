import type { PrismaClient } from "@prisma/client";
import { FolioState, InvoiceState, InvoiceType, Stage } from "@prisma/client";
import { NotFoundError, StateTransitionError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { enforceNoOpenDuplicateFlagsForS2Exit } from "../../policies/04-duplicate-detection/p12-open-duplicate-flag-blocks-s2-exit.js";
import { enforceQuotationValidityNotLapsedForS2Exit } from "../../policies/08-pricing-rate-plan/p07-quotation-validity-not-lapsed-for-s2-exit.js";
import { enforceDiscountApprovalBeforeSend } from "../../policies/09-discount/p23-discount-send-requires-approval.js";
import { enforceSpeculativeHoldActiveForS2Exit } from "../../policies/10-speculative-hold/p25-speculative-hold-active-for-s2-exit.js";
import { enforceBillingModelAllowlistFromConfig } from "../../policies/13-billing-model/p30-billing-model-allowlist-from-config.js";
import { enforceQuotationAckOpenLoopResolvedForS2Exit } from "../../policies/20-communication-acknowledgement-tracking/p52-quotation-ack-open-loop-resolved-for-s2-exit.js";
import { enforceAcceptedQuotationPresentForS2Exit } from "../../policies/08-pricing-rate-plan/p07-quotation-validity-not-lapsed-for-s2-exit.js";
import { enforceEntryAtS3ForS3DomainOperations } from "../../policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.js";

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
  if (entry.currentStage !== Stage.S2) throw new StateTransitionError("Entry is not at S2");
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

  return prisma.$transaction(async (tx) => {
    await tx.entry.update({ where: { id: entryId }, data: { currentStage: Stage.S3, version: { increment: 1 } } });
    return tx.entry.findUniqueOrThrow({ where: { id: entryId } });
  });
}

export async function ensureProvisionalFolioAndBillingModel(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  input: { billingModel: string },
) {
  if (!input.billingModel?.trim()) throw new ValidationError("billingModel is required");
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true, segments: { orderBy: { segmentNumber: "desc" }, take: 1 } } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS3ForS3DomainOperations({ currentStage: entry.currentStage });
  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  return prisma.$transaction(async (tx) => {
    const allowed = await requireActiveConfigValue<Record<string, string[]>>(tx as any, "billingModel.availablePerSource").catch(
      () => ({} as Record<string, string[]>),
    );
    const flattened = Object.values(allowed).flat();
    enforceBillingModelAllowlistFromConfig({ billingModel: input.billingModel, allowedFlattened: flattened });

    const folio =
      entry.folio ??
      (await tx.folio.create({
        data: { entryId, state: FolioState.PROVISIONAL, billingModel: input.billingModel.trim(), createdBy: actorId, outstandingBalance: 0, advancePaymentReconciliationComplete: false },
      }));

    if (entry.folio) {
      await tx.folio.update({ where: { id: folio.id }, data: { billingModel: input.billingModel.trim() } });
    }

    await tx.billingModelTransitionRecord.create({
      data: { folioId: folio.id, segmentId, fromModel: null, toModel: input.billingModel.trim(), createdBy: actorId },
    });

    // Create a proforma invoice as S3 exit evidence starter.
    await tx.invoice.create({
      data: {
        folioId: folio.id,
        entryId,
        invoiceType: InvoiceType.PROFORMA,
        state: InvoiceState.DRAFT,
        templateKey: "proforma-v1",
        issuedAt: new Date(),
        issuedBy: actorId,
        metadata: { basis: "S3 setup" },
      },
    });

    return tx.folio.findUniqueOrThrow({ where: { id: folio.id }, include: { invoices: true } });
  });
}

