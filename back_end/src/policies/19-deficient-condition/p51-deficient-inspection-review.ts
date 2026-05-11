import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 51 — DEFICIENT Inspection Review Policy (S8).
 * Minimal gate for this slice: when an active DEFICIENT record exists,
 * inspection must not claim NOT_APPLICABLE — it must carry a final flag status.
 */
export function enforceInspectionCarriesFinalDeficientFlagStatus(input: {
  hasActiveDeficientCondition: boolean;
  deficientFlagStatus: "RESOLVED" | "UNRESOLVED_AT_CHECKOUT" | "NOT_APPLICABLE";
}) {
  if (!input.hasActiveDeficientCondition) return;
  if (input.deficientFlagStatus !== "NOT_APPLICABLE") return;
  throw new PolicyGateBlockedError(
    "DEFICIENT_REQUIRES_FLAG_STATUS",
    "Active DEFICIENT flag exists — inspection must carry final deficient status",
  );
}

