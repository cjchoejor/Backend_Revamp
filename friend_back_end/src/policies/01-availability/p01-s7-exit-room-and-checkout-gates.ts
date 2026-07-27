import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 1 — Availability / assignment (SIG-S7→S8 slice).
 */
export function enforceOccupiedRoomAssignmentForS7ToS8(input: { assignment: unknown | null | undefined }) {
  if (input.assignment) return;
  throw new StageGateBlockedError("Occupied room is required to exit S7", "NO_OCCUPIED_ROOM");
}

/**
 * Checkout calendar anchor required before S7→S8 (frozen or entry dates).
 */
export function enforceCheckoutDatePresentForS7ToS8(input: { checkout: Date | null | undefined }) {
  if (input.checkout) return;
  throw new StageGateBlockedError("checkOutDate missing", "MISSING_CHECKOUT_DATE");
}
