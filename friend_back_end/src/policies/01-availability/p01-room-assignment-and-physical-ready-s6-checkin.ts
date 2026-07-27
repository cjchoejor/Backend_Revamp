import { RoomPhysicalState } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 1 — Availability / room readiness (SIG-S6 strict slice).
 * At check-in completion the guest must have an assignment to a room in AVAILABLE_CLEAN or AVAILABLE_INSPECTED.
 */
export function enforceRoomAssignmentPresentForCheckInCompletion(input: { assignment: unknown | null | undefined }) {
  if (input.assignment) return;
  throw new StageGateBlockedError("No room assignment", "NO_ROOM_ASSIGNMENT");
}

export function enforceRoomPhysicalReadyForS6CheckInCompletion(input: { physicalState: RoomPhysicalState }) {
  const ps = input.physicalState;
  if (ps === RoomPhysicalState.AVAILABLE_CLEAN || ps === RoomPhysicalState.AVAILABLE_INSPECTED) return;
  throw new StageGateBlockedError("Room is not in a valid ready state at check-in", "ROOM_NOT_READY");
}
