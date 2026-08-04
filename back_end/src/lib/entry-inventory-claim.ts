/**
 * Which bookings still hold inventory, and which rooms they hold.
 *
 * Shared by the two places that answer "is this room taken on these dates" — the S1 availability
 * search ([s1-availability-service.ts]) and the S3 committed-hold gate
 * ([room-booking-conflicts.ts]). Those two must never drift: if S1 offers a room, S3 has to
 * accept it. Both previously derived a reservation's rooms from `RoomAssignment` rows alone and
 * neither filtered on entry status, which produced two opposite faults (both observed on live
 * data 2026-08-04):
 *
 *  - **A confirmed booking could block nothing.** Room assignments are not created at
 *    confirmation — they arrive at pre-arrival or check-in — so a reserved entry with none
 *    contributed no blockage. Its committed hold covered the gap only until the hold's TTL
 *    lapsed; after that the rooms of a live, confirmed, in-progress booking were offered as
 *    free. ENT-20260727-0009 (S5, ACTIVE, reserved, 0 assignments, hold expired) was exactly
 *    this: invisible to search.
 *
 *  - **Finished bookings blocked forever.** With no status filter, every CLOSED / EXPIRED /
 *    CANCELLED entry kept blocking its rooms for its old dates.
 */
import { EntryStatus, type Prisma } from "@prisma/client";

/**
 * Statuses whose bookings have let go of their rooms.
 *
 * PARKED is deliberately absent: a park is a pause, not a release — the operator intends to
 * resume, and any committed hold placed before the park still stands.
 */
export const INVENTORY_RELEASED_STATUSES: EntryStatus[] = [
  EntryStatus.CANCELLED,
  EntryStatus.EXPIRED,
  EntryStatus.CLOSED,
];

/** Prisma `where` fragment restricting to entries that still hold their rooms. */
export const stillHoldsInventory = {
  status: { notIn: INVENTORY_RELEASED_STATUSES },
} satisfies Prisma.EntryWhereInput;

/** The select needed by `roomsClaimedByReservedEntry`. */
export const reservedEntryRoomsSelect = {
  roomAssignments: { select: { roomId: true } },
  committedHold: { select: { roomId: true, perNightBreakdown: true } },
} as const;

type ReservedEntryRooms = {
  roomAssignments?: Array<{ roomId: string }> | null;
  committedHold?: { roomId: string | null; perNightBreakdown?: Prisma.JsonValue | null } | null;
};

/** Distinct room ids inside a `CommittedHold.perNightBreakdown` snapshot, read defensively. */
function roomIdsFromPerNight(breakdown: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(breakdown)) return [];
  const out = new Set<string>();
  for (const night of breakdown) {
    const rooms = (night as { roomIds?: unknown })?.roomIds;
    if (!Array.isArray(rooms)) continue;
    for (const r of rooms) {
      const id = typeof r === "string" ? r : (r as { roomId?: unknown })?.roomId;
      if (typeof id === "string" && id) out.add(id);
    }
  }
  return [...out];
}

/**
 * The rooms a RESERVED entry occupies.
 *
 * Assignments are authoritative once they exist. Before that — the window between the S4 freeze
 * and pre-arrival — the committed hold is the only record of which rooms were committed, so it
 * is the fallback. Its expiry is deliberately ignored here: once a reservation exists the rooms
 * are committed by the reservation, and a lapsed hold TTL must not un-block them.
 */
export function roomsClaimedByReservedEntry(entry: ReservedEntryRooms | null | undefined): string[] {
  const assigned = (entry?.roomAssignments ?? []).map((a) => a.roomId).filter(Boolean);
  if (assigned.length > 0) return [...new Set(assigned)];
  const hold = entry?.committedHold;
  if (!hold) return [];
  const ids = new Set(roomIdsFromPerNight(hold.perNightBreakdown));
  if (hold.roomId) ids.add(hold.roomId);
  return [...ids];
}
