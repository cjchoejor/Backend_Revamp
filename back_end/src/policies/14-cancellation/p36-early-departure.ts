import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 36 — Early Departure Policy (DEV-SPEC Part 5).
 *
 * Pure evaluator: early departure is only meaningful while in-stay.
 */
export function enforceEarlyDepartureAllowed(input: { currentStage: string }) {
  if (input.currentStage === "S9") {
    throw new PolicyGateBlockedError("EARLY_DEPARTURE_POST_CLOSURE_FORBIDDEN", "Early departure is not applicable after closure");
  }
}

