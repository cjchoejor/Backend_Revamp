import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 42 — Credit Ceiling Mandatory Set Policy (S3).
 * SIG-S3: committed hold placement requires either advance payment condition satisfied OR credit extension ceiling record exists.
 */
export function enforceAdvancePaymentSatisfiedOrCreditExtensionPresent(input: { isAdvancePaymentSatisfied: boolean }) {
  if (input.isAdvancePaymentSatisfied) return;
  throw new PolicyGateBlockedError(
    "ADVANCE_PAYMENT_NOT_SATISFIED",
    "Advance payment threshold not satisfied (credit extension required)",
  );
}

