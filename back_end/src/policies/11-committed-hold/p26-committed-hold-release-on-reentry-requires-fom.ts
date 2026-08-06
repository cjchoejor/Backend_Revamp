import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * SIG-S3: S3→S1 re-entry hold release is a FOM-authorised action.
 * (Grouped under committed-hold placement/release governance in this backend slice.)
 */
export function enforceCommittedHoldReleaseOnReEntryAuthority(input: { actorLevel: "L1" | "L2" | "L3" | "L4" }) {
  if (input.actorLevel !== "L1") return;
  throw new PolicyGateBlockedError("AUTH_REQUIRED_L2", "FOM authority required to release hold on re-entry");
}


/**
 * Releasing another booking's committed hold outright is a GM decision (2026-08-06, operator
 * ruling), a step above the FOM bar for releasing your own hold on a re-entry.
 *
 * The difference is who loses. A re-entry release gives back rooms the SAME booking is stepping
 * away from; this one takes a room off a booking that still wants it, so the guest on the other
 * side finds out only when someone tells them. That belongs with an actor who can weigh both
 * guests, not with the operator who needs the room.
 */
export function enforceCommittedHoldReleaseAuthority(input: { actorLevel: "L1" | "L2" | "L3" | "L4" }) {
  if (input.actorLevel === "L3" || input.actorLevel === "L4") return;
  throw new PolicyGateBlockedError("AUTH_REQUIRED_L3", "GM authority required to release another booking's committed hold");
}
