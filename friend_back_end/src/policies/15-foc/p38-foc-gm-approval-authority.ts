import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 38 — FOC Validation Policy (approval authority surface).
 * SIG-S3: GM approval is required for FOC inclusion once engine validation passes.
 */
export function enforceFocGmApprovalAuthority(input: { actorLevel: "L1" | "L2" | "L3" | "L4" }) {
  if (input.actorLevel === "L3") return;
  throw new PolicyGateBlockedError("AUTH_REQUIRED_L3", "GM authority required");
}

