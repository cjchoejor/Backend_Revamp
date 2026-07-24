import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 16 — Guest Identity Verification (SIG-S6).
 * Check-in completion requires a recorded verification on `GuestProfile`.
 */
export function enforceIdentityVerifiedBeforeCheckInCompletion(input: { identityVerifiedAt: Date | null | undefined }) {
  if (input.identityVerifiedAt) return;
  throw new StageGateBlockedError("Guest identity not verified", "IDENTITY_NOT_VERIFIED");
}
