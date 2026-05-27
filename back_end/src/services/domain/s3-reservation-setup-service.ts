import type { PrismaClient } from "@prisma/client";
import { FolioState, InvoiceState, InvoiceType, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { enforceBillingModelAllowlistFromConfig } from "../../policies/13-billing-model/p30-billing-model-allowlist-from-config.js";
import { enforceEntryAtS3ForS3DomainOperations } from "../../policies/01-availability/p01-entry-at-s3-for-s3-domain-operations.js";
import { allocateReadableId, READABLE_ID_PREFIXES } from "../../lib/readable-id.js";

export { progressS2ToS3 } from "../../state-machines/s2-s3-state-machine.js";

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

    let folio = entry.folio;
    if (!folio) {
      const folioId = await allocateReadableId(tx, READABLE_ID_PREFIXES.FOLIO);
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

    const invoiceId = await allocateReadableId(tx, READABLE_ID_PREFIXES.INVOICE);
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

