import { InventoryClaimState } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 26 — Committed Hold Placement Policy
 * SIG-S3: a committed hold may only be placed on inventory that is actually free for the
 * guest's dates.
 *
 * WHAT CHANGED (2026-07-29)
 * -------------------------
 * "Available" used to mean `Room.currentClaimState ∈ {FREE, SPECULATIVELY_HELD}`. That field
 * is a NOW snapshot with no date dimension, so it answers the wrong question: S3 needs to know
 * whether the room is busy on the GUEST'S dates, not whether it happens to be busy at the
 * instant the operator clicks. The two diverge in ordinary operation — a room occupied tonight
 * is bookable next month; a room already holding an August booking is bookable in October.
 *
 * S1's availability engine has been date-aware since 2026-07-24, so the old gate made S3 refuse
 * rooms S1 had legitimately offered, and also made a booking collide with its OWN hold on retry
 * (the room went COMMITTED_HELD on the first attempt, then failed the FREE check on the second).
 *
 * Authority now splits in two:
 *   - `enforceNoOverlappingBookingForCommittedHold` — commercial: is someone else booked here?
 *   - `enforceCommittedHoldRoomPhysicallyUsable`    — physical: is the room blocked / down for
 *                                                     maintenance during the stay?
 *
 * Claim state is no longer consulted. Housekeeping readiness (DEPARTED_DIRTY and friends) is
 * deliberately NOT a booking gate — same-day turnover is normal — and stays enforced at
 * check-in by the SIG-S6 per-room physical-ready check, which is the correct moment for it.
 */

/** Formats a conflict as "Room 202 — 29 Jul→30 Jul, INQ-… (Dorji Wangmo)" for the operator. */
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
 * Commercial availability: reject when another booking overlaps the requested stay dates.
 * `conflicts` must already exclude the entry placing the hold — a booking never conflicts with
 * itself, which is what makes retrying a committed hold safe.
 */
export function enforceNoOverlappingBookingForCommittedHold(input: {
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
    "INVENTORY_NOT_AVAILABLE",
    `Room is not available for committed hold — ${detail}`,
  );
}

/**
 * Physical availability: a room taken out of service can't be sold no matter what the calendar
 * says. Maintenance only blocks when its deadline falls inside the stay; a deadline that lands
 * before check-in means the work completes first.
 */
export function enforceCommittedHoldRoomPhysicallyUsable(input: {
  roomNumber?: string | null;
  isBlocked: boolean;
  blockedReason?: string | null;
  isUnderMaintenance: boolean;
  maintenanceDeadline?: Date | null;
  checkIn: Date;
  checkOut: Date;
}) {
  const room = input.roomNumber ? `Room ${input.roomNumber}` : "Room";
  if (input.isBlocked) {
    throw new PolicyGateBlockedError(
      "INVENTORY_NOT_AVAILABLE",
      `${room} is blocked${input.blockedReason ? ` — ${input.blockedReason}` : ""}`,
    );
  }
  if (
    input.isUnderMaintenance &&
    input.maintenanceDeadline &&
    input.maintenanceDeadline.getTime() >= input.checkIn.getTime() &&
    input.maintenanceDeadline.getTime() <= input.checkOut.getTime()
  ) {
    throw new PolicyGateBlockedError(
      "INVENTORY_NOT_AVAILABLE",
      `${room} is under maintenance until ${input.maintenanceDeadline.toISOString().slice(0, 10)}, inside the requested stay`,
    );
  }
}

/**
 * Legacy date-blind gate. Retained ONLY for the degenerate case where an entry carries no
 * stay dates, so no date-aware check is possible and the NOW snapshot is the best signal
 * available. Do not use it on any path where check-in / check-out are known.
 *
 * @deprecated Prefer `enforceNoOverlappingBookingForCommittedHold` + `enforceCommittedHoldRoomPhysicallyUsable`.
 */
export function enforceCommittedHoldInventoryAvailable(input: { currentClaimState: InventoryClaimState }) {
  if (input.currentClaimState === InventoryClaimState.FREE) return;
  if (input.currentClaimState === InventoryClaimState.SPECULATIVELY_HELD) return;
  if (input.currentClaimState === InventoryClaimState.COMMITTED_HELD) return; // own-hold retry
  throw new PolicyGateBlockedError("INVENTORY_NOT_AVAILABLE", "Room is not available for committed hold");
}
