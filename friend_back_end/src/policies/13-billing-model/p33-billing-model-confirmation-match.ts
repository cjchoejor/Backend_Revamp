import { PolicyGateBlockedError } from "../../lib/errors.js";

// Policy 33 — Billing Model Settlement (subset: confirmation must match active billing model).
export function enforceBillingModelConfirmationMatches(input: { billingModelConfirmation: string; billingModel: string }) {
  if (input.billingModelConfirmation !== input.billingModel) {
    throw new PolicyGateBlockedError("BILLING_MODEL_CONFIRMATION_MISMATCH", "billingModelConfirmation must match folio.billingModel");
  }
}

