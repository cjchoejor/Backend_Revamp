import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * S3 re-entry (S3→S2 or S3→S1) authority gate.
 * SIG-S3: initiated by FOM (L2). (Grouped as a local re-entry authority guard.)
 */
export function enforceS3ReEntryAuthority(input: { actorLevel: "L1" | "L2" | "L3" | "L4" }) {
  if (input.actorLevel !== "L1") return;
  throw new PolicyGateBlockedError("AUTH_REQUIRED_L2", "FOM authority required");
}

