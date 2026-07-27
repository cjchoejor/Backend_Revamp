import type { PrismaClient } from "@prisma/client";
import { FolioState, InvoiceState, InvoiceType, Stage } from "@prisma/client";
import { AuthorizationError, NotFoundError, ValidationError } from "../../lib/errors.js";
import type { ActorLevel } from "../../types/actor.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { enforceBillingModelAllowlistFromConfig } from "../../policies/13-billing-model/p30-billing-model-allowlist-from-config.js";
import { enforceEntryAtS3ForS3DomainOperations } from "../../policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.js";
import { enforceGroupBillingSplitConfigured } from "../../policies/26-group-foc-billing/p66-group-foc-and-billing-split.js";
import { allocateReadableId, READABLE_ID_PREFIXES } from "../../lib/readable-id.js";

export { progressS2ToS3 } from "../../state-machines/s2-s3-state-machine.js";

export async function ensureProvisionalFolioAndBillingModel(
  prisma: PrismaClient,
  entryId: string,
  actorId: string,
  actorLevel: ActorLevel,
  input: { billingModel: string },
) {
  if (!input.billingModel?.trim()) throw new ValidationError("billingModel is required");
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { folio: true, segments: { orderBy: { segmentNumber: "desc" }, take: 1 } } });
  if (!entry) throw new NotFoundError("Entry");
  enforceEntryAtS3ForS3DomainOperations({ currentStage: entry.currentStage });
  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  // Policy 66 safety-net: a group entry (Policy 64 already set groupBillingMode at S1) may
  // never progress through S3 folio setup without groupBillingMode still on the entry.
  // Someone could have unset it via a direct DB write or a future admin tool; the guard here
  // means the operational flow catches that state before writing the folio.
  const isGroupUseType = entry.useType === "GROUP" || entry.useType === "CONFERENCE";
  enforceGroupBillingSplitConfigured({
    isGroup: isGroupUseType || entry.groupBillingMode != null,
    hasGroupBillingMode: entry.groupBillingMode != null,
  });

  // Authority gate: for GROUP_MASTER entries, moving off the group-friendly billing models
  // (DIRECT_BILL / TOUR_OPERATOR_VOUCHER) requires L3+. Reasoning: converting a group to
  // per-guest billing effectively splits the folio's payment stream and dissolves the
  // group's operational identity — the tour operator / corporate account may have contract
  // language relying on centralized billing. An L1 receptionist should not be able to do
  // this quietly during check-in. L3 (FOM) or higher approves.
  const requestedModel = input.billingModel.trim().toUpperCase();
  const isGroupFriendly = requestedModel === "DIRECT_BILL" || requestedModel === "TOUR_OPERATOR_VOUCHER";
  if (entry.groupBillingMode === "GROUP_MASTER" && !isGroupFriendly) {
    if (actorLevel !== "L3" && actorLevel !== "L4") {
      throw new AuthorizationError(
        `Changing a group booking's billing model to ${requestedModel} requires L3+ authority (this booking was auto-classified as GROUP_MASTER at S1).`,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const allowed = await requireActiveConfigValue<Record<string, string[]>>(tx as any, "billingModel.availablePerSource").catch(
      () => ({} as Record<string, string[]>),
    );
    const flattened = Object.values(allowed).flat();
    enforceBillingModelAllowlistFromConfig({ billingModel: input.billingModel, allowedFlattened: flattened });

    let folio = entry.folio;
    if (!folio) {
      const folioId = await allocateReadableId(tx, "FOLIO" as const);
      folio = await tx.folio.create({
        data: {
          id: folioId,
          entryId,
          state: FolioState.PROVISIONAL,
          billingModel: input.billingModel.trim(),
          createdBy: actorId,
          outstandingBalance: 0,
          advancePaymentReconciliationComplete: false,
        },
      });
    } else {
      await tx.folio.update({ where: { id: folio.id }, data: { billingModel: input.billingModel.trim() } });
    }

    await tx.billingModelTransitionRecord.create({
      data: { folioId: folio.id, segmentId, fromModel: null, toModel: input.billingModel.trim(), createdBy: actorId },
    });

    const invoiceId = await allocateReadableId(tx, "INVOICE" as const);
    // Create a proforma invoice as S3 exit evidence starter.
    await tx.invoice.create({
      data: {
        id: invoiceId,
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

