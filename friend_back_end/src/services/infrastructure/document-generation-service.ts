import type { PrismaClient } from "@prisma/client";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { MissingConfigurationError } from "../../lib/errors.js";

export type QuotationDocumentInput = {
  quotationId: string;
  entryId: string;
  referenceNumber: string;
};

/**
 * SIG-S2 §2.4 / §6.1 — DocumentGenerationInterface slice for quotations.
 * Returns a storage reference; full PDF pipeline can replace internals later.
 */
export async function generateQuotationDocument(prisma: PrismaClient, input: QuotationDocumentInput) {
  const templateKey = await requireActiveConfigValue<string>(prisma, "quotation.document.templateKey").catch(() => {
    throw new MissingConfigurationError("quotation.document.templateKey");
  });
  const storageReference = `quotation-doc:${input.referenceNumber}:${input.quotationId}`;
  return { templateKey, storageReference };
}

export type ConfirmationVoucherInput = {
  reservationId: string;
  entryId: string;
};

/**
 * SIG-S4 §6.1 step 14 — `CONFIRMATION_VOUCHER` document slice (storage ref; PDF pipeline TBD).
 */
export async function generateConfirmationVoucher(prisma: PrismaClient, input: ConfirmationVoucherInput) {
  const templateKey = await requireActiveConfigValue<string>(prisma, "confirmation.document.templateKey").catch(() => "confirmation-v1");
  const storageReference = `confirmation-voucher:${input.reservationId}:${input.entryId}`;
  return { templateKey, storageReference };
}
