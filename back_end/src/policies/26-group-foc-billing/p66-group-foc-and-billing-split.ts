import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 66 — Group FOC and Billing Split Policy (DEV-SPEC Part 5).
 *
 * Pure gate surface; detailed billing logic depends on billing model and folio line patterns.
 */
export function enforceGroupBillingSplitConfigured(input: { isGroup: boolean; hasGroupBillingMode: boolean }) {
  if (!input.isGroup) return;
  if (input.hasGroupBillingMode) return;
  throw new PolicyGateBlockedError("GROUP_BILLING_MODE_REQUIRED", "Group billing mode must be configured for group entries");
}

