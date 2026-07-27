import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 32 — Billing Model Mid-Stay Transition Policy (DEV-SPEC Part 5).
 *
 * Pure evaluator: transition is not allowed unless explicitly governed by authority.
 */
export function enforceBillingModelMidStayTransitionAllowed(input: { currentStage: string; hasAuthority: boolean }) {
  if (!input.hasAuthority) {
    throw new PolicyGateBlockedError("BILLING_MODEL_TRANSITION_REQUIRES_AUTHORITY", "Billing model transition requires higher authority");
  }
  if (input.currentStage === "S8" || input.currentStage === "S9") {
    throw new PolicyGateBlockedError("BILLING_MODEL_TRANSITION_FORBIDDEN_AT_EXIT", "Billing model transition is forbidden at exit/closure stages");
  }
}

