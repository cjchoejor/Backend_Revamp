import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * SIG-S3: S3→S1 re-entry hold release is a FOM-authorised action.
 * (Grouped under committed-hold placement/release governance in this backend slice.)
 */
export function enforceCommittedHoldReleaseOnReEntryAuthority(input: { actorLevel: "L1" | "L2" | "L3" | "L4" }) {
  if (input.actorLevel !== "L1") return;
  throw new PolicyGateBlockedError("AUTH_REQUIRED_L2", "FOM authority required to release hold on re-entry");
}

