import { InventoryClaimState } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 1 — Availability / inventory (SIG-S8 §3.2, §3.4).
 * S8→S9: room must have completed checkout physical path to DEPARTED_DIRTY.
 */
export function enforceRoomDepartedDirtyForS8ToS9(input: { currentClaimState: InventoryClaimState }) {
  if (input.currentClaimState === InventoryClaimState.DEPARTED_DIRTY) return;
  throw new StageGateBlockedError("Room must be DEPARTED_DIRTY before S9", "ROOM_NOT_DEPARTED_DIRTY");
}

/**
 * S8→S9: at least one `KeyReturnRecord` must exist (count reconciliation governed separately).
 */
export function enforceKeyReturnRecordedForS8ToS9(input: { keyReturn: unknown | null | undefined }) {
  if (input.keyReturn) return;
  throw new StageGateBlockedError("Key return not recorded", "KEY_RETURN_NOT_RECORDED");
}
