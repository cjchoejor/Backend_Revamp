import { InvoiceState } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/**
 * Policy 33 — invoice PAYMENT_TRACKED / RECONCILED transitions.
 *
 * A payment is recorded against an invoice that went out (DISPATCHED) or one already tracking
 * payments (PAYMENT_TRACKED) — the second instalment of a company paying in parts
 * (SIG-S9 §8.6: refused only when the invoice is "not in DISPATCHED or PAYMENT_TRACKED state").
 * It used to accept DISPATCHED alone, so after the first instalment the rest could never be
 * recorded (2026-09-18).
 */
export function enforceInvoiceStateForPaymentTracked(input: { currentState: InvoiceState }) {
  if (input.currentState === InvoiceState.DISPATCHED || input.currentState === InvoiceState.PAYMENT_TRACKED) return;
  throw new StateTransitionError(`Invoice must be sent before a payment is recorded against it (current: ${input.currentState})`);
}

export function enforceInvoiceStateForReconciled(input: { currentState: InvoiceState }) {
  if (input.currentState === InvoiceState.PAYMENT_TRACKED) return;
  throw new StateTransitionError(`Invoice must be PAYMENT_TRACKED to mark RECONCILED (current: ${input.currentState})`);
}
