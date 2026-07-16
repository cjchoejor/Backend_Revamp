/**
 * Invoice immutability guard.
 *
 * Once an Invoice has a `pdfStorageKey` set — the PDF has been rendered and stored — the
 * row is considered ISSUED. From that moment on, the only fields allowed to change are:
 *   - `dispatchedAt`, `dispatchedBy`, `dispatchedTo`  (post-issuance send metadata)
 *   - `supersededById`                                 (the pointer to a superseding version)
 *   - `state`                                          (lifecycle transitions: DISPATCHED,
 *                                                      PAYMENT_TRACKED, RECONCILED, SUPERSEDED)
 *
 * Anything else — total amount, template key, invoice number, metadata, lines — must never
 * mutate on an issued row. Corrections issue a NEW Invoice with `versionNumber + 1` and
 * point the OLD row's `supersededById` at the new row. Both files stay in storage forever.
 *
 * Same guard applies to Quotation once its PDF has been rendered (the guest received it).
 * See `assertQuotationMutationAllowed`.
 */
import type { Invoice, Prisma, PrismaClient, Quotation } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";

/** Fields legally mutable on an ISSUED Invoice row. Anything not in this set throws. */
const ISSUED_INVOICE_MUTABLE_FIELDS = new Set<string>([
  "dispatchedAt",
  "dispatchedBy",
  "dispatchedTo",
  "supersededById",
  "state",
]);

/** Fields legally mutable on an ISSUED (rendered + dispatched) Quotation row. */
const ISSUED_QUOTATION_MUTABLE_FIELDS = new Set<string>([
  "state",
  "sealedAt",
  "supersededById",
  "supersededAt",
  "expiredAt",
  "acceptedAt",
  "acceptedBy",
  "communicationRecordId",
  "sentAt",
  "sentTo",
  "folioId",
]);

/**
 * Throws if `attemptedFields` include any column that mustn't change on an ISSUED invoice.
 * `existing` is the current row; the guard only fires when `existing.pdfStorageKey` is set.
 */
export function assertInvoiceMutationAllowed(existing: Invoice, attemptedFields: readonly string[]): void {
  if (!existing.pdfStorageKey) return; // pre-issuance — free to edit
  const bad = attemptedFields.filter((f) => !ISSUED_INVOICE_MUTABLE_FIELDS.has(f));
  if (bad.length > 0) {
    throw new PolicyGateBlockedError(
      "INVOICE_IMMUTABLE",
      `Invoice ${existing.id} has been rendered (pdfStorageKey set). Cannot mutate: ${bad.join(", ")}. Issue a superseding invoice instead.`,
    );
  }
}

export function assertQuotationMutationAllowed(existing: Quotation, attemptedFields: readonly string[]): void {
  if (!existing.pdfStorageKey) return;
  const bad = attemptedFields.filter((f) => !ISSUED_QUOTATION_MUTABLE_FIELDS.has(f));
  if (bad.length > 0) {
    throw new PolicyGateBlockedError(
      "QUOTATION_IMMUTABLE",
      `Quotation ${existing.id} has been rendered (pdfStorageKey set). Cannot mutate: ${bad.join(", ")}. Issue a new version instead.`,
    );
  }
}

/**
 * Wrapper for the common "load, guard, update" flow. Callers pass the field diff they
 * want to write; the wrapper reads the current row, runs the guard, and applies the
 * update inside the same transaction.
 *
 * Prefer this over calling `tx.invoice.update` directly on any post-issuance code path.
 */
export async function updateIssuedInvoice(
  tx: PrismaClient | Prisma.TransactionClient,
  invoiceId: string,
  data: Prisma.InvoiceUpdateInput,
): Promise<Invoice> {
  const existing = await tx.invoice.findUnique({ where: { id: invoiceId } });
  if (!existing) throw new PolicyGateBlockedError("INVOICE_NOT_FOUND", `Invoice ${invoiceId} not found`);
  assertInvoiceMutationAllowed(existing, Object.keys(data));
  return tx.invoice.update({ where: { id: invoiceId }, data });
}
