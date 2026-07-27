import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 21 — Mid-Stay Rate Amendment Policy (DEV-SPEC Part 5).
 *
 * Pure guard surface; detailed recomputation is delegated to pricing pipeline engine
 * in full renegotiation flows.
 */
export function enforceRateAmendmentAllowed(input: { currentStage: string }) {
  // Canon intent: mid-stay amendments are governed; this placeholder enforces stage gating.
  if (input.currentStage === "S7" || input.currentStage === "S8" || input.currentStage === "S9") {
    throw new PolicyGateBlockedError("RATE_AMENDMENT_FORBIDDEN_AT_EXIT", "Rate amendment is not allowed at exit/closure stages");
  }
}

