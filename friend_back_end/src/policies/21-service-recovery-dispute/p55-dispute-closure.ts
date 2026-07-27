import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 55 — Dispute Closure Policy (DEV-SPEC Part 5 / SIG-S9).
 *
 * Pure guard: GM closure requires non-empty closureReason.
 */
export function enforceDisputeClosureReasonPresent(input: { closureReason: string | null | undefined }) {
  if (input.closureReason?.trim()) return;
  throw new PolicyGateBlockedError("DISPUTE_CLOSURE_REASON_REQUIRED", "closureReason is required to close a dispute");
}

