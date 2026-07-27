import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 30 — Billing Model Initial Fix Policy (SIG-S3).
 * When `billingModel.availablePerSource` yields a non-empty allowlist, the chosen model must be listed.
 */
export function enforceBillingModelAllowlistFromConfig(input: { billingModel: string; allowedFlattened: string[] }) {
  if (input.allowedFlattened.length === 0) return;
  const bm = input.billingModel.trim();
  if (input.allowedFlattened.includes(bm)) return;
  throw new PolicyGateBlockedError("BILLING_MODEL_NOT_ALLOWED", "Billing model not allowed by configuration");
}
