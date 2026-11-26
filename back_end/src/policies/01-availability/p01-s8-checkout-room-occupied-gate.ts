import { InventoryClaimState } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

const STATE_WORDS: Record<string, string> = {
  FREE: "free",
  SPECULATIVELY_HELD: "held for a quote",
  COMMITTED_HELD: "held for a booking",
  CONFIRMED: "reserved",
  DEPARTED_DIRTY: "needs cleaning",
  DEPARTED_CLEAN: "cleaned",
};

/**
 * Policy 1 — S8 checkout completion requires each room the guest is LEAVING (the rows that run to
 * the checkout morning, lib/rooms-in-use.ts) to read OCCUPIED. A room left mid-stay is never asked.
 */
export function enforceRoomOccupiedForCheckoutCompletion(input: { currentClaimState: InventoryClaimState; roomNumber?: string }) {
  if (input.currentClaimState === InventoryClaimState.OCCUPIED) return;
  const room = input.roomNumber ? `Room ${input.roomNumber}` : "The room";
  const now = STATE_WORDS[String(input.currentClaimState)] ?? String(input.currentClaimState).toLowerCase();
  throw new StateTransitionError(
    `${room} reads as ${now}, though the guest is checking out of it — its state needs putting right before check-out (tell the FOM).`,
    "INVALID_ROOM_STATE_TRANSITION",
  );
}
