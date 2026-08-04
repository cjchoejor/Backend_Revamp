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

/**
 * Releasing a hold is a GM decision (2026-08-04, operator ruling; was FOM/L2).
 *
 * A held room is inventory already promised to a guest, and letting it go is the moment an
 * overbooking or a lost booking becomes possible — the live case being two operators racing for
 * the same room at S2/S3. The call belongs with someone who can weigh both guests rather than
 * with the operator who wants the room. Placing a hold stays L1: taking inventory off the shelf
 * is ordinary front-desk work, giving it away is not.
 */
export function enforceSpeculativeHoldReleaseAuthority(input: { actorLevel: "L1" | "L2" | "L3" | "L4" }) {
  if (input.actorLevel === "L3" || input.actorLevel === "L4") return;
  throw new PolicyGateBlockedError("AUTH_REQUIRED_L3", "GM authority required to release a speculative hold");
}

