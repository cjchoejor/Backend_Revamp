import { HoldState } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/** Policy 25 — speculative hold release requires PLACED state. */
export function enforceSpeculativeHoldPlacedForRelease(input: { state: HoldState }) {
  if (input.state === HoldState.PLACED) return;
  throw new StateTransitionError("Hold is not in PLACED state", "HOLD_NOT_PLACED");
}
