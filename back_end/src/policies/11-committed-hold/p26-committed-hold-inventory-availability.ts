import { InventoryClaimState } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import type { RoomDateConflict } from "../../lib/room-date-conflicts.js";

/**
 * Policy 26 — Committed Hold Placement Policy
 * SIG-S3: committed hold requires the room to be unclaimed for the requested dates.
 *
 * DATE-BLIND FORM (retained; no longer the S3 call-site guard). `Room.currentClaimState` is a
 * snapshot of the room *right now*, not a per-date view — the availability engine documents
 * this explicitly. Guarding on it meant a room legitimately free for a future stay was refused
 * because a different booking held it today; and since nothing returns a room to FREE after a
 * legacy-imported stay ends, it refused essentially every committed hold in the system. Kept
 * for callers that genuinely mean "is this room free at this instant".
 */
export function enforceCommittedHoldInventoryAvailable(input: { currentClaimState: InventoryClaimState }) {
  if (input.currentClaimState === InventoryClaimState.FREE) return;
  if (input.currentClaimState === InventoryClaimState.SPECULATIVELY_HELD) return;
  throw new PolicyGateBlockedError("INVENTORY_NOT_AVAILABLE", "Room is not available for committed hold");
}

function fmt(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : "?";
}

/**
 * Policy 26 (date-aware, 2026-07-29) — the room must carry no OVERLAPPING claim for the
 * requested stay. Conflicts come from `findRoomDateConflicts`, the same query the S1
 * availability search uses, so what search offers is exactly what this accepts.
 *
 * A room that is OCCUPIED or CONFIRMED today but unclaimed across the requested range passes —
 * that is the point, and it matches what the operator was shown at S1.
 *
 * NOT a loosening of double-booking protection: an overlapping Reservation or a live
 * CommittedHold still blocks. The message names who holds it and for which dates, so the
 * operator can act instead of guessing.
 */
export function enforceCommittedHoldRoomFreeForDates(input: {
  roomNumber?: string | null;
  roomId: string;
  conflicts: RoomDateConflict[];
}) {
  const mine = input.conflicts.filter((c) => c.roomId === input.roomId);
  if (mine.length === 0) return;
  const first = mine[0];
  const who = first.source === "RESERVED" ? "a confirmed reservation" : "a committed hold";
  throw new PolicyGateBlockedError(
    "INVENTORY_NOT_AVAILABLE",
    `Room ${input.roomNumber ?? ""} is already taken for these dates — ${who} on ${first.entryId} covers ${fmt(first.startDate)} to ${fmt(first.endDate)}.`.replace(/\s+/g, " "),
  );
}

