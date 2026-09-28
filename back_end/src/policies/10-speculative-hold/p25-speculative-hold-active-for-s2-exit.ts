import { PolicyGateBlockedError } from "../../lib/errors.js";

const ACTIVE_SPEC_HOLD_STATES = new Set(["PLACED", "UPGRADED"]);

/**
 * A hold that has already finished — the FOM released it, or it lapsed and W2 expired it. It is
 * history: the rooms went back to FREE when it ended, which is exactly where a booking that never
 * held anything stands.
 */
const FINISHED_SPEC_HOLD_STATES = new Set(["RELEASED", "EXPIRED"]);

/**
 * Policy 25 — Speculative Hold (SIG-S2).
 * S2→S3 exit: a speculative hold the booking is still RELYING ON must be in an active state.
 *
 * SIG-S2 §441 reads "If a `SpeculativeHold` was placed: state = PLACED or UPGRADED", and this
 * guard applied that to every hold row the segment had ever carried — including ones the FOM had
 * deliberately released, which §882 and §1314 describe as ordinary L2+ work. That made releasing
 * a hold strictly worse than never placing one: a booking with NO holds passes this gate, while
 * one that held and released could never reach Set up again. Placing a fresh hold did not rescue
 * it either, because the released rows stayed in the segment and kept tripping the check — so the
 * booking was wedged at S2 with no way forward through the desk or the API. Found 2026-09-28 on
 * ENT-20260928-0001, which carried three RELEASED holds and one accepted quotation.
 *
 * A finished hold is therefore skipped. This is a deliberate, recorded deviation from a literal
 * reading of §441 — the spec's rule is about the hold being carried forward, and a released one
 * is not being carried anywhere. Nothing is loosened by it: the rooms a released hold used to
 * block are FREE, and the committed hold placed at S3 re-checks every room against the dates
 * through Policy 26 before anything is held again.
 *
 * Anything that is neither active nor finished still blocks — a speculative hold should never
 * read CONFIRMED (that is a committed hold's state), so an unexpected value is worth refusing.
 */
export function enforceSpeculativeHoldActiveForS2Exit(input: { segmentHolds: Array<{ state?: string | null }> }) {
  const bad = input.segmentHolds.find((h) => {
    const state = String(h.state ?? "");
    return !ACTIVE_SPEC_HOLD_STATES.has(state) && !FINISHED_SPEC_HOLD_STATES.has(state);
  });
  if (!bad) return;
  throw new PolicyGateBlockedError("SPEC_HOLD_NOT_ACTIVE", "Speculative hold is not active");
}
