import { HandoffState } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 5 — H1 custodian transfer (SIG-S6 completion slice).
 * Standard path: H1 must be FULFILLED or CLOSED. Walk-in compressed path skips H1 when absent.
 */
export function enforceH1EligibleForS6CheckInCompletion(input: {
  walkInCompressed: boolean | null | undefined;
  h1: { state: HandoffState } | null | undefined;
}) {
  const isWalkIn = input.walkInCompressed === true || !input.h1;
  if (isWalkIn) return;
  const s = input.h1!.state;
  if (s === HandoffState.FULFILLED || s === HandoffState.CLOSED) return;
  throw new StageGateBlockedError("H1 must be FULFILLED or CLOSED", "H1_INVALID");
}
