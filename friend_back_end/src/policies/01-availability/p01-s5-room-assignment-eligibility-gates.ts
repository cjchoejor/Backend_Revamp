import { RoomPhysicalState, Stage } from "@prisma/client";
import { PolicyGateBlockedError, StageGateBlockedError } from "../../lib/errors.js";

/** Policy 1 — room assignment entry stage (S5 path or re-entry from S6/S1). */
export function enforceRoomAssignmentEntryStage(input: {
  currentStage: Stage;
  reEntryToS1?: boolean;
}) {
  const atS5 = input.currentStage === Stage.S5;
  const reEntry =
    input.reEntryToS1 === true && (input.currentStage === Stage.S6 || input.currentStage === Stage.S1);
  if (atS5 || reEntry) return;
  throw new StageGateBlockedError("Entry must be at stage S5 for room assignment", "NOT_AT_S5");
}

/** Policy 1 — at most one room assignment on normal S5 path (immutable in this slice). */
export function enforceNoExistingRoomAssignmentOnS5Path(input: { currentStage: Stage; hasExistingAssignment: boolean }) {
  if (input.currentStage !== Stage.S5) return;
  if (!input.hasExistingAssignment) return;
  throw new PolicyGateBlockedError("ROOM_ASSIGNMENT_IMMUTABLE", "This entry already has a room assignment (immutable in S5 slice)");
}

/** Policy 26 — committed hold must exist for room assignment against confirmed inventory. */
export function enforceCommittedHoldPresentForRoomAssignment(input: { hold: unknown | null | undefined }) {
  if (input.hold) return;
  throw new StageGateBlockedError("No committed hold for this entry", "NO_COMMITTED_HOLD");
}

/** Policy 1 — assigned room must match hold room type. */
export function enforceRoomTypeMatchesHoldForAssignment(input: { roomRoomTypeId: string; holdRoomTypeId: string }) {
  if (input.roomRoomTypeId === input.holdRoomTypeId) return;
  throw new PolicyGateBlockedError("ROOM_TYPE_MISMATCH", "Room does not match confirmed room type on hold");
}

/** Policy 1 — arrival date must be derivable for assignment eligibility. */
export function enforceArrivalDatePresentForRoomAssignment(input: { arrival: Date | null | undefined }) {
  if (input.arrival) return;
  throw new StageGateBlockedError("No arrival date on reservation", "NO_ARRIVAL_DATE");
}

/** Policy 1 — room physical state must allow assignment relative to arrival (incl. scheduled maintenance). */
export function enforceRoomPhysicallyAssignableForS5(input: {
  physicalState: RoomPhysicalState;
  expectedReadyAt: Date | null;
  arrival: Date;
}) {
  const { physicalState, expectedReadyAt, arrival } = input;
  const valid =
    physicalState === RoomPhysicalState.AVAILABLE_CLEAN ||
    physicalState === RoomPhysicalState.AVAILABLE_INSPECTED ||
    physicalState === RoomPhysicalState.DIRTY ||
    (physicalState === RoomPhysicalState.UNDER_MAINTENANCE && expectedReadyAt != null && expectedReadyAt <= arrival);

  if (valid) return;

  if (physicalState === RoomPhysicalState.UNDER_MAINTENANCE && !expectedReadyAt) {
    throw new PolicyGateBlockedError(
      "UNDER_MAINTENANCE_WITHOUT_SCHEDULE",
      "Room is under maintenance without expectedReadyAt before arrival",
    );
  }
  throw new PolicyGateBlockedError("ROOM_NOT_ASSIGNABLE_PHYSICAL_STATE", `Room physical state is ${physicalState}`);
}
