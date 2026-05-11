import { RoomPhysicalState } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 1 — Availability Query Policy (S5 slice).
 *
 * SIG-S5 exit condition uses the same physical-readiness model:
 * room must be AVAILABLE_CLEAN / AVAILABLE_INSPECTED, or UNDER_MAINTENANCE with expectedReadyAt <= arrival.
 */
export function enforceAssignedRoomPhysicalReadinessForArrival(input: {
  physicalState: RoomPhysicalState;
  expectedReadyAt: Date | null | undefined;
  arrivalAt: Date | null | undefined;
}) {
  const ok =
    input.physicalState === RoomPhysicalState.AVAILABLE_CLEAN ||
    input.physicalState === RoomPhysicalState.AVAILABLE_INSPECTED ||
    (input.physicalState === RoomPhysicalState.UNDER_MAINTENANCE &&
      input.expectedReadyAt != null &&
      input.arrivalAt != null &&
      input.expectedReadyAt <= input.arrivalAt);

  if (ok) return;
  throw new StageGateBlockedError("Assigned room is not in a valid physical state for arrival", "ROOM_NOT_READY");
}

