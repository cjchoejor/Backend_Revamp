import { InventoryClaimState } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 25 — Speculative Hold Placement Policy (S2).
 * SIG-S2: blocks if actor authority insufficient or inventory not eligible.
 */
export function enforceSpeculativeHoldAuthority(input: {
  authorityRequired: "FRONT_DESK" | "FOM" | "GM";
  actorLevel: "L1" | "L2" | "L3" | "L4";
}) {
  const required = input.authorityRequired;
  const level = input.actorLevel;
  const insufficient =
    (required === "FOM" && level === "L1") ||
    (required === "GM" && (level === "L1" || level === "L2"));

  if (!insufficient) return;
  throw new PolicyGateBlockedError(
    "SPECULATIVE_HOLD_REQUIRES_ESCALATION",
    `Speculative hold requires ${required} authority`,
  );
}

export function enforceSpeculativeHoldInventoryEligible(input: { currentClaimState: InventoryClaimState }) {
  // SIG-S2: FREE or QUOTED inventory can be spec-held.
  if (input.currentClaimState === InventoryClaimState.FREE) return;
  if ((input.currentClaimState as any) === "QUOTED") return;
  throw new PolicyGateBlockedError("ROOM_NOT_FREE", "Room is not available for speculative hold");
}

export function enforceSpeculativeHoldReleaseAuthority(input: { actorLevel: "L1" | "L2" | "L3" | "L4" }) {
  if (input.actorLevel !== "L1") return;
  throw new PolicyGateBlockedError("AUTH_REQUIRED_L2", "FOM authority required to release speculative hold");
}

