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

const RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };

/**
 * Authority for the in-place room change (2026-08-13 operator ruling, superseding the
 * 2026-08-12 stage tiering): the line is WHAT the change does commercially, not which stage
 * it runs from. A SAME-TYPE swap moves the guest to an equivalent room at the identical rate
 * — a logistics decision the desk (L1+) makes at any of S5–S7. A CROSS-TYPE move is an
 * upgrade or downgrade: the stay re-prices at the new type's rate, so FOM and above (L2+)
 * decide it, again at any stage.
 */
export function enforceRoomChangeAuthorityForStage(input: {
  currentStage: string;
  actorLevel: "L1" | "L2" | "L3" | "L4";
  /** true when the replacement room is the SAME room type as the one it replaces. */
  sameType: boolean;
}) {
  const need = input.sameType ? 1 : 2;
  if ((RANK[input.actorLevel] ?? 0) >= need) return;
  throw new PolicyGateBlockedError(
    "AUTH_REQUIRED_L2",
    `Moving to a different room type is an upgrade/downgrade — it re-prices the stay, so it needs FOM authority (L2+); the acting user is ${input.actorLevel}. A same-type swap needs no approval.`,
  );
}
