import { InventoryClaimState } from "@prisma/client";

/**
 * Who owns `Room.currentClaimState`, and when a hold may write it.
 *
 * The flag is a NOW snapshot with no date dimension (see CLAUDE.md, "Room availability is
 * decided by DATES, never by `currentClaimState`"). Availability and the S3 hold gate both
 * decide by date overlap, so two bookings can legitimately hold the same room for different
 * nights — and only ONE of them can be described by a single flag. The hold ROW is the truth;
 * the flag is what the rooms board and the desk read.
 *
 * `s2-hold-service` has followed this since 2026-08-06 — it pins only a FREE flag, "the display
 * flag is only pinned when this hold actually owns it". The committed-hold paths never did, and
 * that gap was PMS-236: a future-dated booking placing a hold on a room occupied TONIGHT wrote
 * OCCUPIED -> COMMITTED_HELD, the S8 gate then refused the in-house guest's checkout ("Room must
 * be OCCUPIED"), and releasing that same hold would have set an occupied room FREE.
 *
 * Three predicates, one rule each, so the six write sites cannot drift apart again.
 */

/**
 * The flag is reporting where the room PHYSICALLY stands — someone is in it, or has just left
 * it and housekeeping has not finished. A hold for other dates must never overwrite this: doing
 * so loses a live occupancy or a pending clean, and neither is a claim a hold owns.
 */
export function claimFlagReportsPhysicalState(state: InventoryClaimState): boolean {
  return (
    state === InventoryClaimState.OCCUPIED ||
    state === InventoryClaimState.DEPARTED_DIRTY ||
    state === InventoryClaimState.DEPARTED_CLEAN
  );
}

/**
 * A committed hold may PIN the flag only when nothing stronger owns it: an unclaimed room, or
 * this booking's own speculative hold being upgraded. A room already COMMITTED_HELD is left
 * alone (idempotent retry), and CONFIRMED belongs to another booking's other-dates claim.
 */
export function committedHoldMayPinClaimFlag(state: InventoryClaimState): boolean {
  return state === InventoryClaimState.FREE || state === InventoryClaimState.SPECULATIVELY_HELD;
}

/**
 * A committed hold may CLEAR the flag only when it reads a state a committed hold itself sets.
 * Anything else belongs to someone else — a speculative hold, or the room's physical situation.
 */
export function committedHoldMayFreeClaimFlag(state: InventoryClaimState): boolean {
  return state === InventoryClaimState.COMMITTED_HELD || state === InventoryClaimState.CONFIRMED;
}
