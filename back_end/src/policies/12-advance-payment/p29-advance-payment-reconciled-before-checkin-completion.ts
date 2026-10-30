import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 29 — Advance Payment Balance Verification (SIG-S6).
 * Unreconciled advance-payment flags block folio conversion at check-in completion.
 */
export function enforceAdvancePaymentReconciledBeforeCheckInCompletion(input: { advancePaymentReconciliationComplete: boolean }) {
  if (input.advancePaymentReconciliationComplete) return;
  throw new StageGateBlockedError("Advance payment not reconciled", "ADVANCE_PAYMENT_UNRECONCILED");
}

/**
 * The rest of the bill, promised at check-in (2026-10-29, operator ruling: "Wait for the FOM").
 * A guest whose payment plan says the rest comes at check-in is not checked in while money is
 * still to pay — unless an FOM (L2+) agreed a later time (`CheckInPaymentDeferral` APPROVED in
 * this pass). The figure is the server's: the stay total less the money received.
 */
export function enforceCheckInBalancePaidOrDeferred(input: {
  promisedAtCheckIn: boolean;
  stillToPay: number;
  deferralApproved: boolean;
  stillToPayWords: string;
}) {
  if (!input.promisedAtCheckIn || input.stillToPay <= 0 || input.deferralApproved) return;
  throw new StageGateBlockedError(
    `The guest said they would pay the rest at check-in — ${input.stillToPayWords} is still to pay. Record the payment, or ask the FOM to let them pay later.`,
    "CHECKIN_BALANCE_DUE",
  );
}
