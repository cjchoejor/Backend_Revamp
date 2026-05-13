import { InvoiceState } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/** Policy 33 — invoice PAYMENT_TRACKED / RECONCILED transitions. */
export function enforceInvoiceStateForPaymentTracked(input: { currentState: InvoiceState }) {
  if (input.currentState === InvoiceState.DISPATCHED) return;
  throw new StateTransitionError(`Invoice must be DISPATCHED to mark PAYMENT_TRACKED (current: ${input.currentState})`);
}

export function enforceInvoiceStateForReconciled(input: { currentState: InvoiceState }) {
  if (input.currentState === InvoiceState.PAYMENT_TRACKED) return;
  throw new StateTransitionError(`Invoice must be PAYMENT_TRACKED to mark RECONCILED (current: ${input.currentState})`);
}
