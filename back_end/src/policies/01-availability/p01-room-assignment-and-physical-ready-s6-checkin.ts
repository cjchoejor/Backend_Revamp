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

function notReadyWords(physicalState: RoomPhysicalState, roomNumber?: string | null): string {
  const room = roomNumber ? `Room ${roomNumber}` : "The room";
  if (physicalState === RoomPhysicalState.DIRTY) {
    return `${room} hasn't been cleaned since the last guest left — housekeeping marks it clean on the Housekeeping page, then check in.`;
  }
  if (physicalState === RoomPhysicalState.UNDER_MAINTENANCE) return `${room} is under maintenance and not ready for a guest.`;
  return `${room} is not ready for a guest.`;
}

export function enforceRoomPhysicalReadyForS6CheckInCompletion(input: { physicalState: RoomPhysicalState; roomNumber?: string | null }) {
  const ps = input.physicalState;
  if (ps === RoomPhysicalState.AVAILABLE_CLEAN || ps === RoomPhysicalState.AVAILABLE_INSPECTED) return;
  throw new StageGateBlockedError(notReadyWords(ps, input.roomNumber), "ROOM_NOT_READY");
}
