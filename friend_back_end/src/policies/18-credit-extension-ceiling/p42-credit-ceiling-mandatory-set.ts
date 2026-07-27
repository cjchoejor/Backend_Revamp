import { PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";

// Policy 42 — Credit Ceiling Mandatory Set (enforcement surface used in this slice).
export function enforceCreditExtensionConstraints(input: {
  actorLevel: "L1" | "L2" | "L3" | "L4";
  ceilingAmount: number;
  reason: string;
}) {
  if (input.actorLevel === "L1") throw new PolicyGateBlockedError("AUTH_REQUIRED_L2", "FOM authority required");
  if (!Number.isFinite(input.ceilingAmount) || input.ceilingAmount <= 0) {
    throw new PolicyGateBlockedError("MISSING_CEILING_AMOUNT", "ceilingAmount must be > 0");
  }
  if (!input.reason?.trim()) throw new ValidationError("reason is required");
}

