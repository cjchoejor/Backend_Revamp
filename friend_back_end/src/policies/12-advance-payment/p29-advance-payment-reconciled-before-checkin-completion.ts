import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 29 — Advance Payment Balance Verification (SIG-S6).
 * Unreconciled advance-payment flags block folio conversion at check-in completion.
 */
export function enforceAdvancePaymentReconciledBeforeCheckInCompletion(input: { advancePaymentReconciliationComplete: boolean }) {
  if (input.advancePaymentReconciliationComplete) return;
  throw new StageGateBlockedError("Advance payment not reconciled", "ADVANCE_PAYMENT_UNRECONCILED");
}
