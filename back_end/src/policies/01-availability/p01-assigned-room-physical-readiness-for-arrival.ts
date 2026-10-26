import { RoomPhysicalState } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 1 — Availability Query Policy (S5 slice).
 *
 * SIG-S5 exit condition uses the same physical-readiness model:
 * room must be AVAILABLE_CLEAN / AVAILABLE_INSPECTED, or UNDER_MAINTENANCE with expectedReadyAt <= arrival.
 */
function notReadyWords(physicalState: RoomPhysicalState, roomNumber?: string | null): string {
  const room = roomNumber ? `Room ${roomNumber}` : "The room";
  if (physicalState === RoomPhysicalState.DIRTY) {
    return `${room} hasn't been cleaned since the last guest left — housekeeping marks it clean on the Housekeeping page, then check in.`;
  }
  if (physicalState === RoomPhysicalState.UNDER_MAINTENANCE) return `${room} is under maintenance and not ready for a guest.`;
  return `${room} is not ready for a guest.`;
}

export function enforceAssignedRoomPhysicalReadinessForArrival(input: {
  physicalState: RoomPhysicalState;
  roomNumber?: string | null;
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
  throw new StageGateBlockedError(notReadyWords(input.physicalState, input.roomNumber), "ROOM_NOT_READY");
}

