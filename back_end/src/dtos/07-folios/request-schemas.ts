import { z } from "zod";

export const recordFolioPaymentRequestSchema = z.object({
  entryId: z.string().min(1),
  amount: z.coerce.number().refine((n) => Number.isFinite(n) && n > 0, "amount must be positive"),
  notes: z.string().optional(),
});
export type RecordFolioPaymentRequestDto = z.infer<typeof recordFolioPaymentRequestSchema>;

export const issueProformaInvoiceRequestSchema = z.object({
  entryId: z.string().min(1),
  templateKey: z.string().optional(),
});
export type IssueProformaInvoiceRequestDto = z.infer<typeof issueProformaInvoiceRequestSchema>;

export const advancePaymentReconcileRequestSchema = z.object({
  entryId: z.string().min(1),
  note: z.string().optional(),
});
export type AdvancePaymentReconcileRequestDto = z.infer<typeof advancePaymentReconcileRequestSchema>;

export const recordCreditExtensionRequestSchema = z.object({
  ceilingAmount: z.coerce.number().refine((n) => Number.isFinite(n) && n > 0, "ceilingAmount must be positive"),
  reason: z.string().min(1),
});
export type RecordCreditExtensionRequestDto = z.infer<typeof recordCreditExtensionRequestSchema>;

/** Same route serves S7 charges and S9 post-stay charges; only `entryId` is universally required before stage split. */
export const postFolioChargesBodySchema = z
  .object({
    entryId: z.string().min(1),
    lineType: z.string().optional(),
    description: z.string().optional(),
    amount: z.coerce.number().optional(),
    currency: z.string().optional(),
    chargeDate: z.string().optional(),
    postedAt: z.string().optional(),
    isPostStay: z.boolean().optional(),
  })
  .passthrough();
export type PostFolioChargesBodyDto = z.infer<typeof postFolioChargesBodySchema>;
export type PostFolioChargeRequestDto = PostFolioChargesBodyDto;

export const correctFolioChargeRequestSchema = z.object({
  entryId: z.string().min(1),
  originalFolioLineId: z.string().min(1),
  reason: z.string().min(1),
  correctionAmount: z.coerce.number(),
  correctionDate: z.string().min(1),
});
export type CorrectFolioChargeRequestDto = z.infer<typeof correctFolioChargeRequestSchema>;

export const postCreditNoteRequestSchema = z.object({
  entryId: z.string().min(1),
  description: z.string().min(1),
  amount: z.coerce.number().refine((n) => Number.isFinite(n) && n > 0, "amount must be positive"),
  currency: z.string().optional(),
  creditDate: z.string().min(1),
});
export type PostCreditNoteRequestDto = z.infer<typeof postCreditNoteRequestSchema>;

export const initiateSettlementRequestSchema = z.object({
  settlementMethod: z.string().min(1),
  billingModelConfirmation: z.string().min(1),
  paymentVerificationRef: z.string().optional(),
  partialAmount: z.coerce.number().optional(),
  fomAcknowledgementRef: z.string().optional(),
  nightAuditFomAcknowledgementRef: z.string().optional(),
  voucherAmount: z.coerce.number().optional(),
});
export type InitiateSettlementRequestDto = z.infer<typeof initiateSettlementRequestSchema>;

export const dispatchInvoiceRequestSchema = z.object({
  dispatchedTo: z.string().optional(),
});
export type DispatchInvoiceRequestDto = z.infer<typeof dispatchInvoiceRequestSchema>;

export const recordInvoicePaymentEventRequestSchema = z.object({
  nextState: z.enum(["PAYMENT_TRACKED", "RECONCILED"]),
  paymentRef: z.string().optional(),
  // SIG-S9 §8.6 payload (kept optional for backward compatibility with earlier tests).
  amount: z.coerce.number().optional(),
  paymentMethod: z.string().optional(),
  receivedAt: z.string().optional(),
  referenceNumber: z.string().optional(),
  proofAttachmentId: z.string().optional(),
});
export type RecordInvoicePaymentEventRequestDto = z.infer<typeof recordInvoicePaymentEventRequestSchema>;

export const writeOffOutstandingBalanceRequestSchema = z.object({
  amount: z.coerce.number().refine((n) => Number.isFinite(n) && n > 0, "amount must be positive"),
  // Leave semantic enforcement to policy (`WRITE_OFF_REASON_REQUIRED`) for consistent 409 behaviour.
  reason: z.string(),
});
export type WriteOffOutstandingBalanceRequestDto = z.infer<typeof writeOffOutstandingBalanceRequestSchema>;

export const postStayChargeRequestSchema = z.object({
  entryId: z.string().min(1),
  lineType: z.string().min(1),
  description: z.string().min(1),
  amount: z.coerce.number(),
  currency: z.string().optional(),
  postedAt: z.string().min(1),
  isPostStay: z.literal(true),
});
export type PostStayChargeRequestDto = z.infer<typeof postStayChargeRequestSchema>;
