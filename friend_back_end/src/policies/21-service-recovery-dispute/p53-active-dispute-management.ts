import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 53 — Active Dispute Management Policy (DEV-SPEC Part 5).
 *
 * Pure evaluator: at S9 closure all disputes must be terminal; active disputes must not be ignored.
 */
export function enforceDisputeNotInExhaustedState(input: { status: string }) {
  if (input.status === "DISPUTE_EXHAUSTED") {
    throw new PolicyGateBlockedError("DISPUTE_EXHAUSTED_FORBIDDEN", "DISPUTE_EXHAUSTED is not a valid state");
  }
}

