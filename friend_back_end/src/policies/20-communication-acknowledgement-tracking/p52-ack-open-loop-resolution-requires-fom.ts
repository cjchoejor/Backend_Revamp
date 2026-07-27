import { PolicyGateBlockedError } from "../../lib/errors.js";

/** Atlas Cat 06 group 20 (§5.2.20) — P52 Communication / Acknowledgement Tracking. */
export function enforceAckOpenLoopResolutionRequiresFom(input: { actorLevel: "L1" | "L2" | "L3" | "L4" }) {
  if (input.actorLevel === "L1") {
    throw new PolicyGateBlockedError("ACK_OPEN_LOOP_REQUIRES_FOM", "FOM authority required to resolve acknowledgement open loop");
  }
}
