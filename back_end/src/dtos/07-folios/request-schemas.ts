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
  /**
   * Split-billing bucket (Phase 3, 2026-07-25). At S8/S9 this tags the new FINAL invoice
   * with a specific `billingModel` so the PDF renderer only includes matching folio lines
   * and downstream settlement scopes payments per-bucket. Ignored at S3 (proforma is always
   * whole-folio at fixation time). Omit to fall back to legacy whole-folio behaviour.
   */
  billingModel: z.string().optional(),
});
export type IssueProformaInvoiceRequestDto = z.infer<typeof issueProformaInvoiceRequestSchema>;

export const advancePaymentReconcileRequestSchema = z.object({
  entryId: z.string().min(1),
  note: z.string().optional(),
});
export type AdvancePaymentReconcileRequestDto = z.infer<typeof advancePaymentReconcileRequestSchema>;

export const recordCreditExtensionRequestSchema = z
  .object({
    ceilingAmount: z.coerce.number().refine((n) => Number.isFinite(n) && n > 0, "ceilingAmount must be positive"),
    reason: z.string().min(1),
    /**
     * Optional time limit (2026-08-01): the extension stops satisfying the advance-payment
     * condition this many hours after approval. Omit/null = no expiry.
     */
    validForHours: z.coerce
      .number()
      .refine((n) => Number.isFinite(n) && n > 0, "validForHours must be positive")
      .optional()
      .nullable(),
    /**
     * Absolute expiry (2026-08-07) — lets the desk align the extension's clock with the
     * guest's payment promise (promised date / check-in / check-out). Wins over validForHours.
     */
    validUntil: z.string().datetime({ offset: true }).optional().nullable(),
  })
  .refine((b) => !(b.validForHours != null && b.validUntil != null), {
    message: "Give validForHours or validUntil, not both",
  });
export type RecordCreditExtensionRequestDto = z.infer<typeof recordCreditExtensionRequestSchema>;

/**
 * The guest's stated advance payment plan (2026-08-07), captured with their answer to the
 * proforma: FULL (whole amount at once), PARTIAL (part now, rest later), INSTALLMENTS
 * (several payments) — plus WHEN the remainder is coming. BEFORE_CHECKIN carries the promised
 * date and arms the W38 deadline timer; AT_CHECKIN / AT_CHECKOUT need no date (the stage is
 * the deadline). CLEAR wipes the plan.
 */
export const setAdvancePaymentPlanRequestSchema = z
  .object({
    plan: z.enum(["FULL", "PARTIAL", "INSTALLMENTS", "CLEAR"]),
    // AT_CHECKOUT removed 2026-08-08 (operator ruling): the advance settles before or at
    // check-in — check-out money is ordinary folio settlement. Stored legacy plans keep the
    // value read-side; new writes are refused here and in the service.
    balanceDueAt: z.enum(["BEFORE_CHECKIN", "AT_CHECKIN"]).optional().nullable(),
    promisedBy: z.string().datetime({ offset: true }).optional().nullable(),
    note: z.string().max(500).optional().nullable(),
  })
  // Only a plan with a REMAINDER must state its timing. FULL may state it too (2026-08-19: the
  // guest paying the whole amount "on Friday" — the date arms the same W38 promise clock) or
  // leave it empty, which means they are paying now.
  .refine((b) => (b.plan === "PARTIAL" || b.plan === "INSTALLMENTS" ? b.balanceDueAt != null : true), {
    message: "Say when the remainder is coming: before check-in, or at check-in",
  })
  .refine((b) => (b.balanceDueAt === "BEFORE_CHECKIN" ? b.promisedBy != null : true), {
    message: "A before-check-in promise needs the date the guest gave",
  })
  .refine((b) => (b.promisedBy != null ? b.balanceDueAt === "BEFORE_CHECKIN" : true), {
    message: "A promised date belongs to a before-check-in plan — set balanceDueAt to BEFORE_CHECKIN or drop the date",
  });
export type SetAdvancePaymentPlanRequestDto = z.infer<typeof setAdvancePaymentPlanRequestSchema>;

/**
 * Operator-set advance requirement (2026-08-01): how much the guest has to pay before the
 * booking confirms — a flat amount, a percentage of the operative quotation's total
 * (converted server-side), or CLEAR to fall back to the configured thresholds.
 */
export const setAdvanceRequirementRequestSchema = z
  .object({
    mode: z.enum(["AMOUNT", "PERCENT", "CLEAR"]),
    amount: z.coerce.number().refine((n) => Number.isFinite(n) && n > 0, "amount must be positive").optional(),
    percent: z.coerce
      .number()
      .refine((n) => Number.isFinite(n) && n > 0 && n <= 100, "percent must be in (0, 100]")
      .optional(),
  })
  .refine((b) => (b.mode === "AMOUNT" ? b.amount != null : true), { message: "amount is required for mode AMOUNT" })
  .refine((b) => (b.mode === "PERCENT" ? b.percent != null : true), { message: "percent is required for mode PERCENT" });
export type SetAdvanceRequirementRequestDto = z.infer<typeof setAdvanceRequirementRequestSchema>;

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
    /** Per-room folio attribution (2026-08-14) — optional; must be a room of this booking. */
    roomId: z.string().optional(),
  })
  .passthrough();
export type PostFolioChargesBodyDto = z.infer<typeof postFolioChargesBodySchema>;
export type PostFolioChargeRequestDto = PostFolioChargesBodyDto;

export const correctFolioChargeRequestSchema = z
  .object({
    entryId: z.string().min(1),
    originalFolioLineId: z.string().min(1),
    reason: z.string().min(1),
    /** Signed delta added as a new line (e.g. −50 to reduce an 800 charge). */
    correctionAmount: z.coerce.number().optional(),
    /** Target net for the original charge line; server computes the delta. Preferred over correctionAmount. */
    correctToAmount: z.coerce.number().optional(),
    correctionDate: z.string().min(1),
  })
  .superRefine((v, ctx) => {
    const hasDelta =
      v.correctionAmount != null && Number.isFinite(v.correctionAmount) && v.correctionAmount !== 0;
    const hasTarget = v.correctToAmount != null && Number.isFinite(v.correctToAmount);
    if (hasDelta && hasTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide either correctionAmount or correctToAmount, not both",
      });
      return;
    }
    if (!hasDelta && !hasTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide correctionAmount (signed delta) or correctToAmount (target net for the charge line)",
      });
    }
  });
export type CorrectFolioChargeRequestDto = z.infer<typeof correctFolioChargeRequestSchema>;

export const postCreditNoteRequestSchema = z.object({
  entryId: z.string().min(1),
  description: z.string().min(1),
  amount: z.coerce.number().refine((n) => Number.isFinite(n) && n > 0, "amount must be positive"),
  currency: z.string().optional(),
  creditDate: z.string().min(1),
  /** Per-room folio attribution (2026-08-14) — optional; must be a room of this booking. */
  roomId: z.string().optional(),
});
export type PostCreditNoteRequestDto = z.infer<typeof postCreditNoteRequestSchema>;

export const initiateSettlementRequestSchema = z.object({
  settlementMethod: z.string().min(1),
  billingModelConfirmation: z.string().min(1),
  /**
   * Split-billing target bucket (Phase 3, 2026-07-25). When present, settlement scopes to
   * ONLY the folio lines with this `billingModel`; a per-bucket invoice + per-bucket payment
   * are produced. When omitted → legacy whole-folio behaviour (uses `folio.billingModel`).
   * The value must match one of the folio's line-level `billingModel` values.
   */
  billingModel: z.string().optional(),
  paymentVerificationRef: z.string().optional(),
  partialAmount: z.coerce.number().optional(),
  fomAcknowledgementRef: z.string().optional(),
  nightAuditFomAcknowledgementRef: z.string().optional(),
  voucherAmount: z.coerce.number().optional(),
});
export type InitiateSettlementRequestDto = z.infer<typeof initiateSettlementRequestSchema>;

/** Interim payment request at S7 (2026-08-21): the ask as a % or a Nu amount of the projected total. */
export const createInterimPaymentRequestSchema = z
  .object({
    askMode: z.enum(["PERCENT", "AMOUNT"]),
    askValue: z.coerce.number().refine((n) => Number.isFinite(n) && n > 0, "askValue must be positive"),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => v.askMode !== "PERCENT" || v.askValue <= 100, { message: "A percentage ask is at most 100" });
export type CreateInterimPaymentRequestDto = z.infer<typeof createInterimPaymentRequestSchema>;

export const recordInterimPaymentRequestSchema = z.object({
  amount: z.coerce.number().refine((n) => Number.isFinite(n) && n > 0, "amount must be positive"),
  paymentMethod: z.string().trim().max(40).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type RecordInterimPaymentRequestDto = z.infer<typeof recordInterimPaymentRequestSchema>;

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

// ─── Split-billing (Phase 2) ────────────────────────────────────────────────────
// Values must match `SPLIT_BILLING_ALLOWED_VALUES` in the policy file. Kept as a plain
// string enum here to avoid an import cycle between DTOs and services; the service
// re-validates via `enforceSplitBillingValueAllowed`.
const splitBillingModelSchema = z.enum(["GUEST_PAY", "DIRECT_BILL", "GOVERNMENT"]);
const folioLineTypeSchema = z.enum(["ROOM_CHARGE", "F_AND_B", "SERVICE", "OTHER", "CREDIT_NOTE"]);

/**
 * Update the folio's per-line-type default map. Partial — only the keys you send get merged
 * into the existing map. `reason` is optional (defaults update is a system-level operator
 * choice, not tied to a specific guest event).
 */
export const updateBillingModelDefaultsRequestSchema = z.object({
  defaults: z.record(folioLineTypeSchema, splitBillingModelSchema).refine(
    (obj) => Object.keys(obj).length > 0,
    "At least one line-type default must be supplied",
  ),
  reason: z.string().optional(),
});
export type UpdateBillingModelDefaultsRequestDto = z.infer<typeof updateBillingModelDefaultsRequestSchema>;

/** Reassign ONE folio line to a different billing model. `reason` mandatory — this is a
 *  per-line override with money implications; audit trail requires context. */
export const reassignFolioLineBillingModelRequestSchema = z.object({
  billingModel: splitBillingModelSchema,
  reason: z.string().min(1, "reason is required"),
});
export type ReassignFolioLineBillingModelRequestDto = z.infer<typeof reassignFolioLineBillingModelRequestSchema>;

/** Reassign many folio lines at once. Same reason required; applies to all updates in this
 *  batch (typical use: "agent agreed to cover F&B — flip all F_AND_B lines for this stay"). */
export const reassignFolioLinesBulkRequestSchema = z.object({
  updates: z
    .array(
      z.object({
        folioLineId: z.string().min(1),
        billingModel: splitBillingModelSchema,
      }),
    )
    .min(1, "At least one update is required"),
  reason: z.string().min(1, "reason is required"),
});
export type ReassignFolioLinesBulkRequestDto = z.infer<typeof reassignFolioLinesBulkRequestSchema>;
