import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 1 — Availability (SIG-S5 slice).
 * S5→S6: a room assignment must exist before advancing to check-in execution.
 */
export function enforceRoomAssignmentPresentForS5ToS6(input: { assignment: unknown | null | undefined }) {
  if (input.assignment) return;
  throw new StageGateBlockedError("Room assignment is required", "NO_ROOM_ASSIGNMENT");
}
