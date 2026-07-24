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
