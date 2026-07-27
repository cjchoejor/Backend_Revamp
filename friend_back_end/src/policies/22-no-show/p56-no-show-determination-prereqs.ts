import { PolicyGateBlockedError, StateTransitionError } from "../../lib/errors.js";

/**
 * Policy 56 — No-Show Detection and Determination Policy (S5).
 * SIG-S5: determination requires cutoff reached + at least one contact attempt.
 */
export function enforceNoShowDeterminationPrereqs(input: {
  hasCutoffReached: boolean;
  contactAttemptCount: number;
}) {
  if (input.contactAttemptCount < 1) {
    throw new PolicyGateBlockedError("CONTACT_ATTEMPTS_REQUIRED", "At least one contact attempt is required");
  }
  if (!input.hasCutoffReached) {
    throw new PolicyGateBlockedError("CUTOFF_NOT_REACHED", "No-show cutoff has not been recorded for this entry");
  }
}

/** Policy 56 — at most one no-show determination per entry in this slice. */
export function enforceNoShowDeterminationNotAlreadyRecorded(input: { hasExistingDetermination: boolean }) {
  if (!input.hasExistingDetermination) return;
  throw new StateTransitionError("No-show determination already recorded for this entry");
}

