import { InventoryClaimState } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 26 — Committed Hold Placement Policy
 * SIG-S3: committed hold requires inventory claim state FREE or SPECULATIVELY_HELD.
 */
export function enforceCommittedHoldInventoryAvailable(input: { currentClaimState: InventoryClaimState }) {
  if (input.currentClaimState === InventoryClaimState.FREE) return;
  if (input.currentClaimState === InventoryClaimState.SPECULATIVELY_HELD) return;
  throw new PolicyGateBlockedError("INVENTORY_NOT_AVAILABLE", "Room is not available for committed hold");
}

