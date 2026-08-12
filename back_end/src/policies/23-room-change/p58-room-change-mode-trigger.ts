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
 * Authority for the in-place room change (2026-08-12 operator ruling, aligned with SIG-S7 §398's
 * tiering): at S5 the rooms are still pre-arrival planning, so the desk (L1+) changes them — the
 * same authority `assignRoom` already grants. From S6 the guest is at the desk or in-house and a
 * change touches handoffs, keys and (cross-type) money, so FOM (L2+) decides — matching the
 * authority of the re-entry buttons this composite replaces.
 */
export function enforceRoomChangeAuthorityForStage(input: {
  currentStage: string;
  actorLevel: "L1" | "L2" | "L3" | "L4";
}) {
  const need = input.currentStage === "S5" ? 1 : 2;
  if ((RANK[input.actorLevel] ?? 0) >= need) return;
  throw new PolicyGateBlockedError(
    "AUTH_REQUIRED_L2",
    `A room change at ${input.currentStage} needs FOM authority (L2+) — the acting user is ${input.actorLevel}`,
  );
}
