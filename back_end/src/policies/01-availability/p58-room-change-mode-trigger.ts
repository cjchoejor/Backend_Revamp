import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 58 — Room Change Mode Trigger Policy (DEV-SPEC Part 5).
 *
 * Pure gate: room changes must occur through governed paths (no direct RoomAssignment.roomId edits).
 */
export function enforceRoomChangeNotDirectEdit(input: { isDirectEdit: boolean }) {
  if (!input.isDirectEdit) return;
  throw new PolicyGateBlockedError("ROOM_CHANGE_FORBIDDEN_DIRECT_EDIT", "Room change must be governed; direct edit is forbidden");
}

