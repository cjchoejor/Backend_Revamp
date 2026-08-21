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

/**
 * Authority for a POST-FREEZE RE-PRICE (2026-08-19) — the S2 negotiation table brought to
 * S5–S7, where the operator edits the confirmed booking's compositions and discount in place.
 *
 * The line follows the same principle as the room-change rule above: WHAT the change does
 * commercially, not which stage it runs from. Two kinds:
 *
 *  - **Operational** — occupancy, meal plans, extra beds. These re-price as a CONSEQUENCE of a
 *    changed booking, and the 2026-08-14 ruling already put them in the desk's hands (L1+),
 *    which is where they stay.
 *  - **Commercial** — a negotiated rate, an FOC waiver, a service-charge / GST waiver, or the
 *    booking discount. Editing those on a CONFIRMED booking is a rate revision, and the
 *    backflow table already prices that authority: RATE_REVISION is L2+ before the guest is
 *    in-house (S4→S2) and L3+ once they are (S7→S2, GM only). Routing a rate revision through
 *    the room-change mode must not be a cheaper door into the same act, so this mirrors it.
 *
 * (A cross-type room CHANGE re-prices too, at L2+, but that is a different act: it prices a
 * room the booking did not hold before, at that type's own published rate — nobody is
 * negotiating the rate itself.)
 */
export function enforceRepriceAuthorityForStage(input: {
  currentStage: string;
  actorLevel: "L1" | "L2" | "L3" | "L4";
  /** true when the edit touches a negotiated rate, FOC, an SC/GST waiver, or the discount. */
  touchesCommercialTerms: boolean;
}) {
  if (!input.touchesCommercialTerms) return;
  const inHouse = input.currentStage === "S7";
  const need = inHouse ? 3 : 2;
  if ((RANK[input.actorLevel] ?? 0) >= need) return;
  throw new PolicyGateBlockedError(
    inHouse ? "AUTH_REQUIRED_L3" : "AUTH_REQUIRED_L2",
    inHouse
      ? `Changing the rate, a waiver or the discount while the guest is in-house is a mid-stay rate revision — that is the GM's call (L3+); the acting user is ${input.actorLevel}. Occupancy, meals and extra beds can still be changed here.`
      : `Changing the rate, a waiver or the discount on a confirmed booking is a rate revision — it needs FOM authority (L2+); the acting user is ${input.actorLevel}. Occupancy, meals and extra beds can still be changed here.`,
  );
}
