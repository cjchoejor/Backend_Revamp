import { PolicyGateBlockedError, StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 7 — Quotation Validity Policy (SIG-S2).
 * S2→S3 exit: accepted quotation must not be past `validUntil` (revalidation required if lapsed).
 */
export function enforceQuotationValidityNotLapsedForS2Exit(input: { validUntil: Date | null | undefined; nowMs?: number }) {
  const until = input.validUntil;
  if (!until) return;
  const now = input.nowMs ?? Date.now();
  if (until.getTime() >= now) return;
  throw new PolicyGateBlockedError("QUOTATION_VALIDITY_LAPSED", "Accepted quotation validity lapsed; revalidation required");
}

/** Policy 7 — active segment must have an ACCEPTED quotation before S2→S3 progression. */
export function enforceAcceptedQuotationPresentForS2Exit(input: { hasAcceptedQuotation: boolean }) {
  if (input.hasAcceptedQuotation) return;
  throw new StageGateBlockedError("Accepted quotation required for S2→S3", "NO_ACCEPTED_QUOTATION");
}

/**
 * Policy 7 — active segment must have a GENERATED quotation before S2→S3 progression.
 *
 * Replaces `enforceAcceptedQuotationPresentForS2Exit` at the S2 exit and S4 confirmation call
 * sites per the operator's generate-vs-send ruling (2026-07-28): producing the quotation is
 * mandatory, emailing it to the guest is not, so the gate cannot require an acceptance that is
 * only recordable on a sent quote.
 *
 * **Deviation from SIG-S2 §1.4.1**, which reads "At least one Quotation record exists in
 * QuotationState.ACCEPTED for the current entry and current segment". Deliberate and directed;
 * recorded in CLAUDE.md. Acceptance is still captured when it happens — it is evidence on the
 * record and shows on the desk, it just no longer blocks the stage.
 *
 * The kept `enforceAcceptedQuotationPresentForS2Exit` above is the spec-strict form, retained so
 * the stricter rule can be restored by swapping the call site back.
 */
export function enforceQuotationGeneratedForS2Exit(input: { hasQuotation: boolean }) {
  if (input.hasQuotation) return;
  throw new StageGateBlockedError(
    "A quotation must be generated for this segment before S2→S3",
    "NO_QUOTATION_GENERATED",
  );
}
