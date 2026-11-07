import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 28 — Advance Payment Reconciliation Policy (S5 exit to S6).
 * SIG-S5: reconciliation must be complete before check-in.
 */
export function enforceAdvancePaymentReconciliationComplete(input: { isReconciled: boolean }) {
  if (input.isReconciled) return;
  throw new StageGateBlockedError(
    "The advance is not signed off yet — open Payments: record the rest of it, or the GM marks it reconciled",
    "RECONCILIATION_INCOMPLETE",
  );
}

