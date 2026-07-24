import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 20 — Commitment rate freeze at S4 (SIG-S4 §4).
 * The commitment snapshot must carry a finite S2-resolved nightly rate when commercial terms provide a rate basis.
 * `PricingPipelineEngine.resolve()` is not invoked at S4 (re-entry aside).
 */
export function enforceCommitmentRateFreezeAtS4(input: { frozenRate: number; hasCommercialRateBasis: boolean }) {
  if (!input.hasCommercialRateBasis) return;
  if (!Number.isFinite(input.frozenRate) || input.frozenRate <= 0) {
    throw new PolicyGateBlockedError(
      "MISSING_FROZEN_RATE",
      "A positive frozen nightly rate is required for the reservation snapshot (Policy 20)",
    );
  }
}
