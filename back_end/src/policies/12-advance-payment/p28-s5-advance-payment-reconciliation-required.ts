import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 28 — Advance Payment Reconciliation Policy (S5 exit to S6).
 * SIG-S5: reconciliation must be complete before check-in.
 */
export function enforceAdvancePaymentReconciliationComplete(input: { isReconciled: boolean }) {
  if (input.isReconciled) return;
  throw new StageGateBlockedError("Advance payment reconciliation not complete", "RECONCILIATION_INCOMPLETE");
}

