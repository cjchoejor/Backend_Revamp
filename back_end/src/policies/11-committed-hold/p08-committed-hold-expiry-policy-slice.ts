import { HoldState } from "@prisma/client";

/**
 * Policy 8 — Committed Hold Expiry (governed release).
 * Structural guard for timer-driven expiry: only **PLACED** holds may transition to **RELEASED** via expiry.
 * Operational enforcement lives in `workers/w3-committed-hold-expiry-worker.ts`.
 */
export function enforceCommittedHoldEligibleForExpiryTransition(input: { state: HoldState }): { eligible: boolean } {
  if (input.state !== HoldState.PLACED) return { eligible: false };
  return { eligible: true };
}
