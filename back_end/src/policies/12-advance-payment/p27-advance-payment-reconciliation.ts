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

/**
 * Money is taken against the bill the guest received (2026-08-01 operator ruling): an S3
 * advance payment cannot be recorded until a proforma invoice has been DISPATCHED. The freeze
 * gate `enforceProformaDispatchedWhenAdvancePaid` (p40) checks the same pairing after the
 * fact; this one enforces the ORDER up front, so the mismatch can't be created at all.
 * Superseded proformas don't count — a re-issued bill has to go out again.
 */
export function enforceProformaDispatchedBeforeAdvancePayment(input: {
  proformaInvoices: Array<{ state: string; dispatchedAt: Date | string | null }>;
}) {
  const dispatched = input.proformaInvoices.some((i) => i.state !== "SUPERSEDED" && i.dispatchedAt != null);
  if (dispatched) return;
  throw new PolicyGateBlockedError(
    "PROFORMA_NOT_DISPATCHED_FOR_ADVANCE",
    "Dispatch the proforma invoice to the guest before recording an advance payment — money is taken against the bill they received",
  );
}

