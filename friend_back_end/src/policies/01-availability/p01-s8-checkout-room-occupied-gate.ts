import { InventoryClaimState } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/** Policy 1 — S8 checkout completion requires room in OCCUPIED claim state. */
export function enforceRoomOccupiedForCheckoutCompletion(input: { currentClaimState: InventoryClaimState }) {
  if (input.currentClaimState === InventoryClaimState.OCCUPIED) return;
  throw new StateTransitionError("Room must be OCCUPIED to check out", "INVALID_ROOM_STATE_TRANSITION");
}
