import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 24 — Mid-Stay Discount Policy (DEV-SPEC Part 5).
 *
 * Pure guard surface; approval/authority is handled by Policy 23.
 */
export function enforceMidStayDiscountWindowOpen(input: { currentStage: string }) {
  if (input.currentStage !== "S7") return;
  // Allowed at S7 in this backend slice; no-op.
}

export function enforceDiscountNotAppliedPostClosure(input: { currentStage: string }) {
  if (input.currentStage === "S9") {
    throw new PolicyGateBlockedError("DISCOUNT_POST_CLOSURE_FORBIDDEN", "Discounts cannot be applied post-closure");
  }
}

