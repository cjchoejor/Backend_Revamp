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
 * S2→S3 exit: a speculative hold being carried into Set up must be active.
 *
 * SIG-S2 §441 reads "if a SpeculativeHold was placed: state = PLACED or UPGRADED". The first cut
 * applied that to EVERY hold row of the segment, and a booking that had held rooms and released
 * them could then never leave Negotiation: RELEASED is terminal, a fresh hold does not remove the
 * released rows, and a booking with NO hold passes — so releasing a hold (ordinary L2+ work, SIG-S2
 * §882 / §1314, with a button on the desk) left the booking strictly worse off than never holding,
 * and the only way out was a re-entry that threw the quotation away. Found on the deployment
 * machine 2026-09-28 (ENT-20260928-0001, three RELEASED holds, "Any holds still healthy" unticked).
 *
 * Ruling (2026-09-28, a recorded deviation from the literal §441): a FINISHED hold — RELEASED or
 * EXPIRED — does not block. §441 is singular; it is about the hold being carried forward into S3,
 * where it upgrades into the committed hold. A hold the FOM released is not being carried anywhere.
 * Nothing is loosened by it: the rooms a released hold used to block are free, and the committed
 * hold placed at S3 re-checks every room against the dates through Policy 26 before anything is
 * held again. Anything neither active nor finished still refuses — a speculative hold should never
 * read CONFIRMED (that is a committed hold's state), and an unknown state is not trusted.
 */
export function enforceSpeculativeHoldActiveForS2Exit(input: { segmentHolds: Array<{ state?: string | null }> }) {
  const bad = input.segmentHolds.find((h) => {
    const state = String(h.state ?? "");
    return !ACTIVE_SPEC_HOLD_STATES.has(state) && !FINISHED_SPEC_HOLD_STATES.has(state);
  });
  if (!bad) return;
  throw new PolicyGateBlockedError("SPEC_HOLD_NOT_ACTIVE", "Speculative hold is not active");
}
