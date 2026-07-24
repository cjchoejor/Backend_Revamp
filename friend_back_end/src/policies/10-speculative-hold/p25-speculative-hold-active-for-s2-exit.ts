import { PolicyGateBlockedError } from "../../lib/errors.js";

const ACTIVE_SPEC_HOLD_STATES = new Set(["PLACED", "UPGRADED"]);

/**
 * Policy 25 — Speculative Hold (SIG-S2).
 * S2→S3 exit: segment speculative holds, if any, must be in an active state.
 */
export function enforceSpeculativeHoldActiveForS2Exit(input: { segmentHolds: Array<{ state?: string | null }> }) {
  const bad = input.segmentHolds.find((h) => !ACTIVE_SPEC_HOLD_STATES.has(String(h.state ?? "")));
  if (!bad) return;
  throw new PolicyGateBlockedError("SPEC_HOLD_NOT_ACTIVE", "Speculative hold is not active");
}
