import type { PrismaClient } from "@prisma/client";
import { FolioState, InvoiceState, InvoiceType, Stage } from "@prisma/client";
import { NotFoundError, StageGateBlockedError, StateTransitionError, ValidationError } from "../lib/errors.js";
import { requireActiveConfigValue } from "../lib/config-store.js";

export async function progressS2ToS3(prisma: PrismaClient, entryId: string, _actorId: string, clientVersion: number | undefined) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { quotations: true, segments: { orderBy: { segmentNumber: "desc" }, take: 1 }, folio: true },
  });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S2) throw new StateTransitionError("Entry is not at S2");
  if (clientVersion == null) throw new ValidationError("version is required");
  if (entry.version !== clientVersion) throw new ValidationError("version mismatch");

  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  const accepted = entry.quotations.find((q) => q.segmentId === segmentId && q.state === "ACCEPTED");
  if (!accepted) throw new StageGateBlockedError("Accepted quotation required for S2→S3", "NO_ACCEPTED_QUOTATION");

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
  if (entry.currentStage !== Stage.S3) throw new StageGateBlockedError("Entry must be at S3", "NOT_AT_S3");
  const segmentId = entry.segments[0]?.id;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  return prisma.$transaction(async (tx) => {
    const allowed = await requireActiveConfigValue<Record<string, string[]>>(tx as any, "billingModel.availablePerSource").catch(
      () => ({} as Record<string, string[]>),
    );
    const flattened = Object.values(allowed).flat();
    if (flattened.length > 0 && !flattened.includes(input.billingModel.trim())) {
      throw new StageGateBlockedError("Billing model not allowed by configuration", "BILLING_MODEL_NOT_ALLOWED");
    }

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

