import { InventoryClaimState } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 25 — Speculative Hold Placement Policy (S2).
 * SIG-S2: blocks if actor authority insufficient or inventory not eligible.
 */
export function enforceSpeculativeHoldAuthority(input: {
  authorityRequired: "FRONT_DESK" | "FOM" | "GM";
  actorLevel: "L1" | "L2" | "L3" | "L4";
}) {
  const required = input.authorityRequired;
  const level = input.actorLevel;
  const insufficient =
    (required === "FOM" && level === "L1") ||
    (required === "GM" && (level === "L1" || level === "L2"));

  if (!insufficient) return;
  throw new PolicyGateBlockedError(
    "SPECULATIVE_HOLD_REQUIRES_ESCALATION",
    `Speculative hold requires ${required} authority`,
  );
}

export function enforceSpeculativeHoldInventoryEligible(input: { currentClaimState: InventoryClaimState }) {
  // SIG-S2: FREE or QUOTED inventory can be spec-held.
  if (input.currentClaimState === InventoryClaimState.FREE) return;
  if ((input.currentClaimState as any) === "QUOTED") return;
  throw new PolicyGateBlockedError("ROOM_NOT_FREE", "Room is not available for speculative hold");
}

/** "Room 202 is reserved 2026-07-29→2026-07-30 by INQ-… · Dorji Wangmo" — mirrors p26. */
function describeConflict(c: {
  roomNumber?: string | null;
  source: "RESERVED" | "HOLD";
  entryReferenceNumber: string | null;
  guestName: string | null;
  startDate: Date;
  endDate: Date;
}) {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const who = [c.entryReferenceNumber, c.guestName].filter(Boolean).join(" · ");
  const label = c.source === "RESERVED" ? "reserved" : "held";
  const room = c.roomNumber ? `Room ${c.roomNumber}` : "Room";
  return `${room} is ${label} ${day(c.startDate)}→${day(c.endDate)}${who ? ` by ${who}` : ""}`;
}

/**
 * Date-aware eligibility (2026-08-06) — the same rewrite Policy 26 got on 2026-07-29, applied
 * to the S2 hold. `Room.currentClaimState` is a NOW snapshot with no date dimension: it goes
 * COMMITTED_HELD at S3 / CONFIRMED at S4 and stays there until departure, so on a hotel with a
 * normal forward book the old gate refused a speculative hold on a room whose only claim was
 * for entirely different dates. The question is "is this room busy on the GUEST'S dates?", and
 * `conflicts` (from `findRoomBookingConflicts`, which already excludes the asking entry) is the
 * answer. Keeps the stable ROOM_NOT_FREE code so callers pattern-matching on it are unaffected.
 */
export function enforceNoOverlappingBookingForSpeculativeHold(input: {
  conflicts: Array<{
    roomNumber?: string | null;
    source: "RESERVED" | "HOLD";
    entryReferenceNumber: string | null;
    guestName: string | null;
    startDate: Date;
    endDate: Date;
  }>;
}) {
  if (input.conflicts.length === 0) return;
  const detail = input.conflicts.map(describeConflict).join("; ");
  throw new PolicyGateBlockedError(
    "ROOM_NOT_FREE",
    `Room is not available for speculative hold — ${detail}`,
  );
}

/**
 * Releasing a hold is a GM decision (2026-08-04, operator ruling; was FOM/L2).
 *
 * A held room is inventory already promised to a guest, and letting it go is the moment an
 * overbooking or a lost booking becomes possible — the live case being two operators racing for
 * the same room at S2/S3. The call belongs with someone who can weigh both guests rather than
 * with the operator who wants the room. Placing a hold stays L1: taking inventory off the shelf
 * is ordinary front-desk work, giving it away is not.
 */
export function enforceSpeculativeHoldReleaseAuthority(input: { actorLevel: "L1" | "L2" | "L3" | "L4" }) {
  if (input.actorLevel === "L3" || input.actorLevel === "L4") return;
  throw new PolicyGateBlockedError("AUTH_REQUIRED_L3", "GM authority required to release a speculative hold");
}

