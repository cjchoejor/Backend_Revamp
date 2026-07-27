import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 56 — No-Show Detection and Determination (S5 sub-state).
 * SIG-S5: when AWAITING_WRITTEN_CONFIRMATION is active, S5→S6 progression is blocked.
 */
export function enforceNotAwaitingWrittenConfirmation(input: { hasAwaitingWrittenConfirmationTimer: boolean }) {
  if (!input.hasAwaitingWrittenConfirmationTimer) return;
  throw new StageGateBlockedError("Awaiting written confirmation — cannot progress", "AWAITING_WRITTEN_CONFIRMATION");
}

