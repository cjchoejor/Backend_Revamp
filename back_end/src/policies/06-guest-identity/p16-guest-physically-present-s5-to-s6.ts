import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 16 — Guest Identity / arrival ceremony (SIG-S5 slice).
 * S5→S6: guest must be physically present at the desk.
 */
export function enforceGuestPhysicallyPresentForS5ToS6(input: { guestPhysicallyPresent: boolean | undefined }) {
  if (input.guestPhysicallyPresent === true) return;
  throw new StageGateBlockedError("Guest physical presence is required for S5→S6", "GUEST_NOT_PRESENT");
}
