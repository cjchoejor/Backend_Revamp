import { HandoffState } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 5 — H1 Handoff Custodian Transfer Policy (S5 exit slice).
 * SIG-S5: H1 must be FULFILLED before S5→S6 progression.
 */
export function enforceH1FulfilledBeforeCheckIn(input: { hasH1: boolean; h1State: HandoffState | null | undefined }) {
  if (!input.hasH1 || input.h1State !== HandoffState.FULFILLED) {
    throw new StageGateBlockedError("H1 handoff must be FULFILLED before check-in", "H1_NOT_FULFILLED");
  }
}

