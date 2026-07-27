import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 27 — Advance Payment Collection Policy (S3).
 * Minimal gate for this backend slice: reconciliation cannot complete without
 * at least one IN payment, unless billing model is direct-bill like.
 */
export function enforceAdvancePaymentReconciliationRequiresPayment(input: {
  isDirectBillLike: boolean;
  totalInPayments: number;
}) {
  if (input.isDirectBillLike) return;
  if (input.totalInPayments > 0) return;
  throw new PolicyGateBlockedError("NO_ADVANCE_PAYMENT", "At least one IN payment is required before reconciliation");
}

