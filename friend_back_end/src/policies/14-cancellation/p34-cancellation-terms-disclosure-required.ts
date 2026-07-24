import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 34 — Cancellation Terms Disclosure Policy
 * SIG-S3: committed hold cannot be placed without a CancellationDisclosureRecord.
 */
export function enforceCancellationDisclosurePresent(input: { hasCancellationDisclosure: boolean }) {
  if (input.hasCancellationDisclosure) return;
  throw new PolicyGateBlockedError(
    "CANCELLATION_DISCLOSURE_REQUIRED",
    "Cancellation disclosure is required before committed hold",
  );
}

